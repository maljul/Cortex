/**
 * THE DEGRADATION LADDER, FORCED — spec/04-ARCHITECTURE.md §5, and U17's done-when.
 *
 *   npm run gate:ladder            force every rung and fire every built brake
 *   npm run gate:ladder -- --meter perform ONE real LIVE run and derive the cap from it
 *
 * `08` §5's done-when for U17, verbatim: "each rung forced deliberately and each produces a
 * working page; each brake fired deliberately and the demo stayed reachable; no credential
 * field anywhere in the UI; demo loads in a private window on a machine that never touched
 * the project." The last clause is Julian's act and belongs with U26's cold read. The rest is
 * this script.
 *
 * §5 invariant 4 is why it exists at all: "Every rung MUST be verified by forcing its limit,
 * not by reasoning about it."
 *
 * **`npm run gate:degrade` is an alias for this and still forces rung 2**, so every existing
 * citation of it in `CLAUDE.md`, `docs/UNITS.md` and `docs/verification-log.md` keeps meaning
 * what it meant. What changed is the path rung 2 is forced on: `scripts/gate-degrade.mts`
 * exercised `runScenario`, which the rebuilt page no longer calls, so it was proving the rung
 * on code the demo had stopped running. It is forced here on `runArm` — U21's workload runner,
 * which is what `POST /demo/run` actually performs.
 *
 * Everything below runs against the **real cluster** as the **real `cortex_demo` principal**.
 * The only things faked are the limits being forced, which is the point of a gate:
 *
 *   rung 1  the day's LIVE counter is set to its cap, and a capability-holding caller is
 *           served REPLAY with the reason on the wire
 *   rung 2  every embedding call is refused with a 429
 *   rung 3  a scope's row budget is filled, and the run is refused before it starts
 *   rung 4  the demo plane is pointed at a socket nothing is listening on
 *
 * **What this script deliberately does not spend.** Only `--meter` calls a reasoning model.
 * The ordinary run costs embeddings and cluster time and nothing else, so it can be run as
 * often as anything else here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { Client } from 'pg';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder } from '../src/db/recorder.js';
import {
  handleDemoRequest,
  useEmbedder,
  useRunStarter,
  type RunJob,
} from '../src/demo/api.js';
import {
  modelAuthor,
  FLEET_MAX_OUTPUT_TOKENS,
  type AuthorResult,
  type PatchAuthor,
} from '../src/demo/author.js';
import { streamRun } from '../src/demo/run.js';
import { runArm } from '../src/demo/workload.js';
import { Embedder } from '../src/embed/titan.js';
import {
  liveRunCostUsd,
  LIVE_BUDGET_USD,
  LIVE_BUDGET_WINDOW_DAYS,
  LIVE_RUNS_PER_DAY,
  LIVE_UNBRAKED_WINDOW_USD,
  MEASURED_REASON_RATE_USD_PER_MTOK,
  METERED_LIVE_RUN,
} from '../src/memory/live-budget.js';
import {
  createDemoSessionPair,
  DEMO_SESSION_ROW_CAP,
  FLEET_RUN_ROW_COST,
} from '../src/memory/demo.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Neither PASS nor FAIL: something specified and not built. Printed so a green gate cannot
 *  be read as "everything §5 asks for exists". */
function todo(label: string, detail: string): void {
  console.log(`  TODO  ${label}\n        ${detail}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function admin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: process.env['CORTEX_DSN'],
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Deletes a demo scope and everything under it. */
async function purge(scope: string): Promise<void> {
  await admin(async (client) => {
    for (const table of ['action_ledger', 'findings', 'claims', 'intents', 'agents']) {
      await client.query(`DELETE FROM ${table} WHERE repo_id = $1`, [scope]);
    }
    await client.query('DELETE FROM repos WHERE id = $1', [scope]);
  });
}

async function readCounter(): Promise<number | null> {
  return admin(async (client) => {
    const { rows } = await client.query<{ runs_used: string }>(
      'SELECT runs_used FROM live_run_budget WHERE day = current_date',
    );
    return rows[0] ? Number(rows[0].runs_used) : null;
  });
}

async function setCounter(used: number): Promise<void> {
  await admin(async (client) => {
    await client.query(
      `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date, $1)
       ON CONFLICT (day) DO UPDATE SET runs_used = $1`,
      [used],
    );
  });
}

async function restoreCounter(original: number | null): Promise<void> {
  await admin(async (client) => {
    if (original === null) {
      await client.query('DELETE FROM live_run_budget WHERE day = current_date');
    } else {
      await client.query(
        `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date, $1)
         ON CONFLICT (day) DO UPDATE SET runs_used = $1`,
        [original],
      );
    }
  });
}

/** Bedrock, refusing. The shape the SDK raises when the account is over its rate. */
async function throttled(): Promise<number[]> {
  throw Object.assign(new Error('Too many requests, please wait before trying again.'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 429 },
  });
}

/** Bedrock, refusing the way a detached IAM policy makes it refuse. */
function accessDenied(): Error {
  return Object.assign(
    new Error('User is not authorized to perform: bedrock:InvokeModel on this resource'),
    { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } },
  );
}

const jsonOf = (body: string): Record<string, unknown> =>
  JSON.parse(body) as Record<string, unknown>;

/**
 * A capability for this process only.
 *
 * The deployed secret is in Secrets Manager and reaches the functions as a
 * `{{resolve:secretsmanager:...}}` dynamic reference. A gate that needed the real one would
 * either read it — putting a live secret in a laptop's process table — or hard-code one, which
 * is the rule this project has broken four times. It generates its own instead: what is under
 * test is the *comparison*, and a comparison does not care which secret it is holding.
 */
function installEphemeralCapability(): string {
  const token = randomBytes(32).toString('base64url');
  process.env['LIVE_TOKEN'] = token;
  return token;
}

// ---------------------------------------------------------------------------------------
// RUNG 1 — LIVE reasoning quota exhausted → REPLAY, stated on screen.
// ---------------------------------------------------------------------------------------

async function rungOne(token: string): Promise<void> {
  section('RUNG 1 — the LIVE quota is exhausted, and the page says so (04 §5)');

  if (LIVE_RUNS_PER_DAY <= 0) {
    check(
      'the cap is a positive number derived from a metered run',
      false,
      'LIVE_RUNS_PER_DAY is 0, so no LIVE run can be authorised and rung 1 cannot be ' +
        'reached. Run `npm run gate:ladder -- --meter` and write METERED_LIVE_RUN.',
    );
    return;
  }

  const jobs: RunJob[] = [];
  useRunStarter(async (job) => void jobs.push(job));

  const session = await createDemoSessionPair();
  const body = {
    session: session.scopes.cortex,
    mode: 'fleet',
    naive: session.scopes.naive,
  };

  try {
    // --- the granted case, so the exhausted one is not vacuous -------------------------
    await setCounter(0);
    const granted = await handleDemoRequest({
      method: 'POST',
      path: '/demo/run',
      query: { live: token },
      body,
    });
    const grantedBody = jsonOf(granted.body);
    const grantedReasoning = grantedBody['reasoning'] as Record<string, unknown> | undefined;

    check(
      'a capability holder under the cap is authorised LIVE',
      granted.statusCode === 202 && grantedReasoning?.['mode'] === 'live',
      `${granted.statusCode} ${String(grantedReasoning?.['mode'])}`,
    );
    check(
      'the slot is spent when it is granted, not when the run succeeds',
      (await readCounter()) === 1,
      `counter ${String(await readCounter())}`,
    );
    check(
      'and the runner is handed the capability to re-check, not a boolean',
      jobs.length === 1 && typeof jobs[0]?.live?.capability === 'string',
      jobs[0]?.live ? 'live.capability present' : 'no live block',
    );

    // --- the rung ----------------------------------------------------------------------
    jobs.length = 0;
    await setCounter(LIVE_RUNS_PER_DAY);
    const exhausted = await handleDemoRequest({
      method: 'POST',
      path: '/demo/run',
      query: { live: token },
      body,
    });
    const exhaustedBody = jsonOf(exhausted.body);
    const reasoning = exhaustedBody['reasoning'] as Record<string, unknown> | undefined;
    const reason = String(reasoning?.['reason'] ?? '');

    check(
      'the run still starts, and is not an error (§5 invariant 1)',
      exhausted.statusCode === 202 && exhaustedBody['started'] === true,
      `${exhausted.statusCode}`,
    );
    check(
      'it is REPLAY and it names rung 1',
      reasoning?.['mode'] === 'replay' && reasoning?.['rung'] === 1,
      `${String(reasoning?.['mode'])} rung ${String(reasoning?.['rung'])}`,
    );
    check(
      'the reason states what degraded and what is still true (§5 invariant 2)',
      /reasoning|model/i.test(reason) && /(database|CockroachDB)/i.test(reason) && /live/i.test(reason),
      '',
    );
    check(
      'no LIVE capability reaches the runner once the quota is gone',
      jobs.length === 1 && jobs[0]?.live === undefined,
      jobs[0]?.live ? 'live block present' : 'absent',
    );
    check(
      'and the exhausted call spent nothing further',
      (await readCounter()) === LIVE_RUNS_PER_DAY,
      `counter ${String(await readCounter())}`,
    );

    // --- design §7.1: without the token, nothing hints that a gate exists ---------------
    jobs.length = 0;
    await setCounter(0);
    const anonymous = await handleDemoRequest({ method: 'POST', path: '/demo/run', body });
    const wrong = await handleDemoRequest({
      method: 'POST',
      path: '/demo/run',
      query: { live: randomBytes(32).toString('base64url') },
      body,
    });
    const anonymousReasoning = JSON.stringify(jsonOf(anonymous.body)['reasoning']);
    const wrongReasoning = JSON.stringify(jsonOf(wrong.body)['reasoning']);

    check(
      'an anonymous run and a wrong-token run are byte-identical (design §7.1)',
      anonymousReasoning === wrongReasoning,
      '',
    );
    check(
      'and neither mentions a quota, a budget or a capability',
      !/quota|budget|token|capability|remain/i.test(anonymousReasoning),
      '',
    );
    check(
      'a wrong token spends no slot',
      (await readCounter()) === null || (await readCounter()) === 0,
      `counter ${String(await readCounter())}`,
    );
    check(
      'the token is never echoed in any response',
      !anonymous.body.includes(token) && !granted.body.includes(token) && !exhausted.body.includes(token),
      '',
    );
  } finally {
    await purge(session.scopes.cortex);
    await purge(session.scopes.naive);
  }
}

/**
 * The other end of rung 1, and the shape `04` §5's brake-3 action and the LIVE IAM kill switch
 * both produce at runtime: the grant is gone, so `bedrock:InvokeModel` is refused.
 *
 * Forced in-process because the deployed `LiveReasoningPolicy` is the thing being tested and
 * detaching it on a live stack to prove a point is a change to production made by a gate.
 * What matters is that the refusal degrades *content* and stops nothing else: the agent still
 * does its ticket, from the reviewed patch, and the run goes on.
 */
async function rungOneUnderIamRefusal(): Promise<void> {
  section('RUNG 1b — the LIVE reasoning grant is refused, and the fleet still works');

  const rejections: string[] = [];
  const author = modelAuthor({
    invoke: async () => {
      throw accessDenied();
    },
    onReject: (reason) => rejections.push(reason),
  });

  const committed = [{ file: 'lib/money.js', find: 'const A = 1;', replace: 'const A = 2;' }];
  const result: AuthorResult = await author({
    taskId: 'T-ladder',
    statement: 'a ticket the model may not be asked about',
    agent: 'agent-1',
    files: { 'lib/money.js': 'const A = 1;\n' },
    findings: [],
    committed,
  });

  check(
    'a refused model call does not throw',
    true,
    `source ${result.source}`,
  );
  check(
    'the agent still applies its ticket, from the reviewed patch',
    result.source === 'fallback' && result.patches.length === committed.length,
    `${result.patches.length} hunk(s)`,
  );
  check(
    'and the refusal is reported rather than swallowed',
    rejections.length === 1 && /authorized|AccessDenied/i.test(rejections[0] ?? ''),
    rejections[0] ?? '(none)',
  );
}

// ---------------------------------------------------------------------------------------
// RUNG 2 — Bedrock embeddings throttled, on the path the demo actually runs.
// ---------------------------------------------------------------------------------------

async function rungTwo(): Promise<void> {
  section('RUNG 2 — every embedding call is refused, on runArm (04 §5, the rung §5 singles out)');

  const session = await createDemoSessionPair();
  const recorder = new StatementRecorder();
  const started = Date.now();

  let result: Awaited<ReturnType<typeof runArm>> | null = null;
  let threw: unknown = null;
  try {
    result = await runArm({
      sessionId: session.scopes.cortex,
      arm: 'cortex',
      embed: throttled,
      recorder,
    });
  } catch (error) {
    threw = error;
  }

  try {
    /**
     * **The one that did not hold, and forcing it is the only way anybody was going to find
     * out.** `04` §5 invariant 4 in one line.
     *
     * `scripts/gate-degrade.mts` proved this rung against `runScenario`, which `POST /demo/run`
     * stopped calling when U21 landed. On `runArm` — the path the deployed page runs — a
     * throttled Bedrock took the demo down: rung 2 skips dedupe by design, so the cortex
     * lane's sequenced duplicate pair was no longer deduplicated, both agents reached the same
     * file, the second one's anchor was gone, `applyAndSave` returned `null`, and `cortexTicket`
     * threw on an assertion whose own comment said the case could not arise. It could, under
     * exactly this rung.
     *
     * That was `04` §5 invariant 1 broken on the path behind the run button — and broken in the
     * shape `src/demo/run.ts`'s header names as the silent break, because `streamRun` converts
     * the throw into a terminal `failed` message rather than an error page. The letter of
     * invariant 1 survives; a judge watching gets half a fleet and a stack trace's message.
     *
     * **Fixed in `src/demo/workload.ts`, and the fix is narrower than the assertion was.** The
     * throw is kept where it still holds — with a real embedding, two cortex agents on one file
     * *is* an arbitration failure — and dropped where it never did: under a degraded embedding
     * it is the documented cost of this rung, reported the way the naive lane reports the same
     * event. So this check now passes, and it is left here as the thing that caught it. Past
     * tense above is deliberate: the condition is gone, and a comment describing a fixed defect
     * as live is the failure this repository names first.
     */
    check(
      'the arm produced a run, not an error (§5 invariant 1)',
      threw === null && result !== null,
      threw === null
        ? `${Date.now() - started}ms`
        : `threw: ${(threw as Error).message} — this rung regressed. ` +
          "`applyAndSave` returning null under a degraded embedding is expected and is handled " +
          'in `src/demo/workload.ts`; a throw here means that handling is gone.',
    );

    // Everything below is asked of statements that already reached the driver and rows that are
    // already in the cluster, so it is answerable whether or not the run finished. A rung that
    // fails on its last step should still report which of its promises it kept.
    const searches = recorder.statements.filter(
      (s) => s.sql.includes('<=>') && /FROM intents/i.test(s.sql),
    );
    check(
      'no similarity search reached the driver — dedupe was skipped, per the transcript',
      searches.length === 0 && recorder.statements.length > 0,
      `${searches.length} in ${recorder.statements.length} statements`,
    );

    const marked = await admin(async (client) => {
      const { rows } = await client.query<{ total: number; marked: number }>(
        `SELECT count(*)::INT AS total,
                count(*) FILTER (WHERE embedding_degraded)::INT AS marked
           FROM intents WHERE repo_id = $1`,
        [session.scopes.cortex],
      );
      return rows[0] ?? { total: 0, marked: 0 };
    });
    check(
      'every intent it wrote is marked degraded in the database',
      marked.total > 0 && marked.total === marked.marked,
      `${marked.marked}/${marked.total} marked`,
    );

    if (!result) return;

    check(
      'the tickets still ran',
      result.steps.length > 0 && Object.keys(result.tree).length > 0,
      `${result.steps.length} steps, ${Object.keys(result.tree).length} files`,
    );
    check(
      'every embedding call was refused and counted',
      result.meter.embeddingCalls > 0,
      `${result.meter.embeddingCalls} calls`,
    );
  } finally {
    await purge(session.scopes.cortex);
    await purge(session.scopes.naive);
  }
}

// ---------------------------------------------------------------------------------------
// RUNG 3 — the per-session row cap.
// ---------------------------------------------------------------------------------------

async function rungThree(): Promise<void> {
  section('RUNG 3 — the session row budget is full, and the session stays inspectable (04 §5)');

  useRunStarter(async () => {
    throw new Error('a capped session must not reach the runner');
  });

  const session = await createDemoSessionPair();
  try {
    // Fill the cortex scope to within less than one run of its cap, as the admin, so the
    // preflight is what refuses rather than a write failing part-way through.
    const fill = DEMO_SESSION_ROW_CAP - FLEET_RUN_ROW_COST + 1;
    const zeroVector = `[${new Array(1024).fill(0).join(',')}]`;
    await admin(async (client) => {
      await client.query(
        `INSERT INTO findings (repo_id, fact, embedding)
         SELECT $1, 'row budget filler ' || g, $2::VECTOR
           FROM generate_series(1, $3) AS g`,
        [session.scopes.cortex, zeroVector, fill],
      );
    });

    const refused = await handleDemoRequest({
      method: 'POST',
      path: '/demo/run',
      body: { session: session.scopes.cortex, mode: 'fleet', naive: session.scopes.naive },
    });
    const body = jsonOf(refused.body);

    check(
      'the run is refused before it starts, without an error status (05 §5)',
      refused.statusCode === 200 && body['started'] === false,
      `${refused.statusCode}`,
    );
    check(
      'it names rung 3 and says a new session is one click',
      body['rung'] === 3 && /one click/i.test(String(body['reason'])),
      '',
    );

    const state = await handleDemoRequest({
      method: 'GET',
      path: '/demo/state',
      query: { session: session.scopes.cortex },
    });
    const stateBody = jsonOf(state.body);
    const rows = stateBody['rows'] as { used: number; remaining: number } | undefined;
    check(
      'the rows and counters stay inspectable',
      state.statusCode === 200 && (rows?.used ?? 0) >= fill,
      `${rows?.used ?? 0} rows used, ${rows?.remaining ?? 0} left`,
    );

    const log = await handleDemoRequest({
      method: 'GET',
      path: '/demo/sql-log',
      query: { session: session.scopes.cortex },
    });
    check('the SQL log stays inspectable', log.statusCode === 200, `${log.statusCode}`);

    const fresh = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
    const freshBody = jsonOf(fresh.body) as unknown as {
      scopes?: { cortex: string; naive: string };
    };
    check('a new session really is one click', fresh.statusCode === 200, `${fresh.statusCode}`);
    if (freshBody.scopes) {
      await purge(freshBody.scopes.cortex);
      await purge(freshBody.scopes.naive);
    }
  } finally {
    await purge(session.scopes.cortex);
    await purge(session.scopes.naive);
  }
}

// ---------------------------------------------------------------------------------------
// RUNG 4 — the cluster or the write path is unavailable.
// ---------------------------------------------------------------------------------------

async function rungFour(): Promise<void> {
  section('RUNG 4 — the write path is unreachable, and nothing claims to be live (04 §5)');

  const real = process.env['CORTEX_DEMO_DSN'];
  if (!real) {
    check('CORTEX_DEMO_DSN is set, so it can be pointed somewhere else', false, 'unset');
    return;
  }

  // The real DSN with its host replaced by a port nothing listens on. Built at run time from
  // the configured value rather than written down: this repository does not put connection
  // strings in files, and a literal here would be the fifth time that rule was broken.
  const dead = new URL(real);
  dead.hostname = '127.0.0.1';
  dead.port = '1';

  await closePool('demo');
  process.env['CORTEX_DEMO_DSN'] = dead.toString();

  try {
    const response = await handleDemoRequest({
      method: 'GET',
      path: '/demo/state',
      query: { session: '00000000-0000-4000-8000-000000000000' },
    });
    const body = jsonOf(response.body);
    const banner = String(body['banner'] ?? '');

    check(
      'the surface answers rather than hanging or throwing',
      response.statusCode === 503 && body['rung'] === 4,
      `${response.statusCode} rung ${String(body['rung'])}`,
    );
    check(
      'it states that nothing is live (§5 invariant 2, rule A7)',
      body['live'] === false && /not live|nothing on this page is live/i.test(banner),
      '',
    );
    check(
      'and it says the walkthrough behind it is pre-recorded',
      /pre-recorded/i.test(banner),
      '',
    );
    check(
      'the connection string is not echoed to the browser',
      !/postgres|sslmode|@/i.test(response.body),
      '',
    );
  } finally {
    await closePool('demo');
    process.env['CORTEX_DEMO_DSN'] = real;
  }

  const recovered = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
  const recoveredBody = jsonOf(recovered.body) as unknown as {
    scopes?: { cortex: string; naive: string };
  };
  check(
    'and the demo comes back the moment the cluster does',
    recovered.statusCode === 200,
    `${recovered.statusCode}`,
  );
  if (recoveredBody.scopes) {
    await purge(recoveredBody.scopes.cortex);
    await purge(recoveredBody.scopes.naive);
  }
}

// ---------------------------------------------------------------------------------------
// THE BRAKES — §5 requires each fired deliberately, with the demo still reachable after it.
// ---------------------------------------------------------------------------------------

async function brakes(token: string): Promise<void> {
  section('BRAKES — fired deliberately, with the demo reachable afterwards (04 §5, rule B4)');

  if (LIVE_RUNS_PER_DAY <= 0) {
    check('brake 2 can be fired', false, 'the cap is 0, so there is nothing to exhaust');
  } else {
    await setCounter(LIVE_RUNS_PER_DAY);
    const session = await createDemoSessionPair();
    useRunStarter(async () => {});
    try {
      const run = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        query: { live: token },
        body: { session: session.scopes.cortex, mode: 'fleet', naive: session.scopes.naive },
      });
      const state = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex },
      });
      const log = await handleDemoRequest({
        method: 'GET',
        path: '/demo/sql-log',
        query: { session: session.scopes.cortex },
      });
      const fresh = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
      const freshBody = jsonOf(fresh.body) as unknown as {
        scopes?: { cortex: string; naive: string };
      };

      check(
        'brake 2 fired: the counter is at its cap and LIVE stopped',
        (await readCounter()) === LIVE_RUNS_PER_DAY &&
          (jsonOf(run.body)['reasoning'] as Record<string, unknown>)['mode'] === 'replay',
        '',
      );
      check(
        'and every route the judge needs still answers (rule B4)',
        run.statusCode === 202 &&
          state.statusCode === 200 &&
          log.statusCode === 200 &&
          fresh.statusCode === 200,
        `run ${run.statusCode} · state ${state.statusCode} · log ${log.statusCode} · session ${fresh.statusCode}`,
      );

      if (freshBody.scopes) {
        await purge(freshBody.scopes.cortex);
        await purge(freshBody.scopes.naive);
      }
    } finally {
      await purge(session.scopes.cortex);
      await purge(session.scopes.naive);
    }
  }

  /**
   * BRAKE 1'S REPLACEMENT — settled here, which is what `docs/UNITS.md` asked U24 to do
   * rather than assume.
   *
   * `04` §5 brake 1 is "reserved concurrency of 2 on the LIVE Lambda", and it is falsified on
   * this account (V26): the account-wide limit is 10, it cannot be raised from the CLI, and it
   * cannot be subdivided at any value. §5 constrains any replacement to target the LIVE
   * reasoning function and nothing else.
   *
   * The answer is that brake 1's intent is met by two things that now exist, and neither is a
   * concurrency reservation:
   *
   *   - the global LIVE run counter, which bounds *spend* and touches nothing else. A spike of
   *     visitors past the cap all get REPLAY runs; the database, the API, the SPA and the read
   *     path are untouched, which is exactly rule B4's requirement of a cost control.
   *   - the account's own 10-slot concurrency ceiling, which bounds *fan-out* — the physical
   *     property §5 wanted brake 1 for — by accident of the very restriction that falsified it.
   *
   * And there is a third, stronger in kind: `LiveReasoningPolicy` in `infra/cdk/`, a managed
   * policy attached to the runner alone, whose detachment stops model calls and nothing else.
   * Rung 1b above forces the runtime shape of that.
   */
  check(
    'brake 1 replacement: the global counter targets LIVE reasoning and nothing else',
    LIVE_RUNS_PER_DAY > 0,
    'the counter gates whether a model author is installed; no other capability reads it',
  );

  /**
   * **Brake 3, which this gate specified as a TODO until 2026-08-16 and now asserts.**
   *
   * It was the only cumulative bound missing: the daily cap is one day's worth of the whole
   * budget, so `LIVE_BUDGET_WINDOW_DAYS` maxed days would have been $270.58 with nothing in the
   * repository to stop it. The stack now carries the Budget, its action and the deny policy.
   *
   * Read out of the stack source rather than the synthesized template, for the reason
   * `test/infra-stack.test.ts` gives: `cdk.out/` is gitignored, so a check against it passes
   * vacuously on a fresh clone. The source is where a regression would be introduced and what a
   * reviewer reads.
   */
  const stackSource = readFileSync(
    resolve(process.cwd(), 'infra/cdk/lib/cortex-stack.ts'),
    'utf8',
  );

  check(
    'brake 3 — an AWS Budget with an action that stops LIVE and nothing else',
    stackSource.includes('CfnBudget') &&
      stackSource.includes('CfnBudgetsAction') &&
      stackSource.includes("'LiveReasoningDenyPolicy'") &&
      stackSource.includes('iam.Effect.DENY'),
    `$${LIVE_BUDGET_USD} budget, APPLY_IAM_POLICY attaching a deny on bedrock:InvokeModel to the runner role`,
  );

  check(
    'brake 3 watches the meter the reasoning spend lands on, not "Amazon Bedrock"',
    stackSource.includes('Claude Haiku 4.5 (Amazon Bedrock Edition)') &&
      stackSource.includes('Claude Sonnet 4.5 (Amazon Bedrock Edition)'),
    'V36: "Amazon Bedrock" carries only the Titan line, so a Budget filtered on it never fires',
  );

  check(
    'brake 3 bounds the whole event rather than each calendar month',
    stackSource.includes("timeUnit: 'ANNUALLY'"),
    `the judging window spans two calendar months; MONTHLY would permit $${LIVE_BUDGET_USD} twice`,
  );
}

// ---------------------------------------------------------------------------------------
// THE METERED RUN — U24's done-when. One real LIVE run, and the cap derived from it.
// ---------------------------------------------------------------------------------------

async function meter(): Promise<void> {
  console.log('METERING ONE LIVE RUN — this calls Bedrock and costs real money.\n');

  const embedder = new Embedder();
  const usage = {
    calls: 0,
    authored: 0,
    fellBack: 0,
    inputTokens: 0,
    outputTokens: 0,
    rejections: [] as string[],
  };
  /** Per call, so the allowance below can be bounded rather than guessed. */
  const inputs: number[] = [];

  const base = modelAuthor({
    ...(process.env['BEDROCK_REGION'] ? { region: process.env['BEDROCK_REGION'] } : {}),
    onReject: (reason) => usage.rejections.push(reason),
  });

  const author: PatchAuthor = async (request) => {
    const result = await base(request);
    if (result.usage) {
      usage.calls += 1;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      inputs.push(result.usage.inputTokens);
    }
    if (result.source === 'model') usage.authored += 1;
    if (result.source === 'fallback') usage.fellBack += 1;
    return result;
  };

  const session = await createDemoSessionPair();
  console.log(`cortex scope ${session.scopes.cortex}`);
  console.log(`naive  scope ${session.scopes.naive}\n`);

  const started = Date.now();
  try {
    const outcome = await streamRun({
      runId: `meter-${Date.now()}`,
      scopes: session.scopes,
      embed: (text) => embedder.embed(text),
      publish: () => {},
      author,
    });

    const elapsed = Date.now() - started;

    /**
     * **THE CALLS BEDROCK BILLED FOR AND `AuthorResult` CANNOT SEE.**
     *
     * `modelAuthor` throws on `stop_reason === 'max_tokens'` — correctly, because half a JSON
     * object is a broken edit rather than a smaller one — but it throws *before* returning the
     * `usage` block, so a truncated call is billed by AWS and counted by nobody. Metering a run
     * from `AuthorResult.usage` alone therefore understates its cost, and the first metered run
     * on 2026-08-16 lost two calls that way: enough to move the derived cap by a whole unit.
     *
     * They are charged here rather than ignored, and bounded rather than estimated:
     *
     *   - output is **exactly** `FLEET_MAX_OUTPUT_TOKENS`, because hitting the ceiling is the
     *     definition of the failure. This is a measurement, not an allowance.
     *   - input is the **largest** input any call in this run actually reported. A truncated
     *     call's prompt is built the same way from the same corpus, so the largest observed
     *     prompt bounds it; charging the mean would be a guess in the cheap direction, and a
     *     brake derived in the cheap direction is not a brake.
     *
     * The measured and charged figures are both printed, so the size of the correction is
     * visible rather than folded away.
     */
    const truncated = usage.rejections.filter((r) => /max_tokens/.test(r)).length;
    const largestInput = inputs.length > 0 ? Math.max(...inputs) : 0;
    const charged = {
      at: '',
      calls: usage.calls + truncated,
      inputTokens: usage.inputTokens + truncated * largestInput,
      outputTokens: usage.outputTokens + truncated * FLEET_MAX_OUTPUT_TOKENS,
    };

    const measuredCost = liveRunCostUsd({ at: '', ...usage });
    const cost = liveRunCostUsd(charged);
    // A run in which no call reached Bedrock has not been metered, whatever it printed. Saying
    // so is the difference between a measurement and a number.
    const cap = cost > 0 ? Math.floor(LIVE_BUDGET_USD / (LIVE_BUDGET_WINDOW_DAYS * cost)) : null;

    console.log(`\nrun ${outcome.phase} in ${(elapsed / 1000).toFixed(1)}s`);
    if (outcome.reason) console.log(`reason: ${outcome.reason}`);
    console.log(`arms: ${outcome.arms.map((a) => `${a.arm} ${a.steps.length} steps`).join(', ')}`);

    console.log('\nBEDROCK USAGE, SUMMED FROM THE MODEL\'S OWN usage BLOCK');
    console.log(`  calls that reported usage  ${usage.calls}`);
    console.log(`  authored                   ${usage.authored}`);
    console.log(`  fell back                  ${usage.fellBack}`);
    console.log(`  input tokens               ${usage.inputTokens}`);
    console.log(`  output tokens              ${usage.outputTokens}`);
    console.log(`  largest single prompt      ${largestInput}`);
    for (const rejection of usage.rejections) console.log(`  rejected: ${rejection}`);

    console.log('\nCHARGED — measured, plus the truncated calls AuthorResult cannot report');
    console.log(`  truncated calls            ${truncated}`);
    console.log(`  calls                      ${charged.calls}`);
    console.log(`  input tokens               ${charged.inputTokens}`);
    console.log(`  output tokens              ${charged.outputTokens}`);

    console.log('\nTHE CAP, DERIVED (design §7.3)');
    console.log(
      `  rate               $${MEASURED_REASON_RATE_USD_PER_MTOK.input}/1M in, ` +
        `$${MEASURED_REASON_RATE_USD_PER_MTOK.output}/1M out`,
    );
    console.log(`  measured cost      $${measuredCost.toFixed(4)}`);
    console.log(`  charged cost       $${cost.toFixed(4)}`);
    console.log(`  budget             $${LIVE_BUDGET_USD} over ${LIVE_BUDGET_WINDOW_DAYS} days`);

    if (cap === null) {
      console.log('  cap = TBD — no call reached Bedrock, so this run was not metered.');
      process.exitCode = 1;
      return;
    }

    console.log(`  cap = budget / (days x cost) = ${cap} runs a day`);
    console.log(
      `\nwrite this into METERED_LIVE_RUN in src/memory/live-budget.ts:\n` +
        `  { at: '${new Date().toISOString().slice(0, 10)}', calls: ${charged.calls}, ` +
        `inputTokens: ${charged.inputTokens}, outputTokens: ${charged.outputTokens} }`,
    );
  } finally {
    await purge(session.scopes.cortex);
    await purge(session.scopes.naive);
    await closePool();
  }
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes('--meter')) {
    await meter();
    return;
  }

  const embedder = new Embedder();
  useEmbedder((text) => embedder.embed(text));

  const token = installEphemeralCapability();
  const originalCounter = await readCounter();

  console.log('forcing every rung of `04` §5 and firing every brake that exists\n');
  console.log(
    METERED_LIVE_RUN
      ? `cap ${LIVE_RUNS_PER_DAY}/day, derived from a metered run on ${METERED_LIVE_RUN.at} ` +
          `(${METERED_LIVE_RUN.inputTokens} in / ${METERED_LIVE_RUN.outputTokens} out, ` +
          `$${liveRunCostUsd(METERED_LIVE_RUN).toFixed(4)} a run)`
      : 'cap 0/day — no metered run exists yet, so LIVE is unavailable by construction',
  );

  try {
    await rungOne(token);
    await rungOneUnderIamRefusal();
    await rungTwo();
    await rungThree();
    await rungFour();
    await brakes(token);
  } finally {
    await restoreCounter(originalCounter);
    delete process.env['LIVE_TOKEN'];
    await closePool();
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.log(`${failures} check(s) failed — the ladder does not hold.`);
    process.exit(1);
  }
  console.log(
    'Every rung was forced and produced a working page; every brake was exercised and the demo\n' +
      'stayed reachable afterwards. That is `08` §5\'s done-when for U17.\n' +
      '\n' +
      'What a green run here does NOT prove: brake 3 is asserted to exist in the stack source,\n' +
      'not fired against a real bill. Firing it would mean spending the budget it protects, so\n' +
      'what is checked is that the Budget, its action and the deny policy are there, that the\n' +
      'filter names the services the spend actually lands on, and that the period bounds the\n' +
      'event rather than the month. `test/infra-stack.test.ts` mutation-tests each of those.',
  );
}

await main();
