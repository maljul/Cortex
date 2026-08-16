/**
 * THE DEMO HTTP SURFACE — spec/05-INTERFACES.md §5.
 *
 * Public, anonymous, and reachable by anyone on the internet with no account. That is a
 * rules requirement (B4) rather than a convenience, and it is why this file is mostly
 * about what it refuses.
 *
 * Deliberately free of AWS types. API Gateway's event shape is adapted in
 * `infra/lambda/demo.ts`; everything decided here — which routes exist, what a request
 * may carry, what a limit looks like on the wire — is decided in a function that
 * `test/demo-plane.test.ts` can call directly against the real cluster. A route surface
 * that can only be exercised after it is deployed is a route surface that is exercised
 * once.
 *
 * All five of `05` §5's routes now exist. U14 built session, state and the stream; U16
 * added `POST /demo/run` and `GET /demo/sql-log`, which are the two that serve `07` §3's
 * beats and `07` §2's show-SQL toggle.
 */
import { randomUUID } from 'node:crypto';

import { StatementRecorder } from '../db/recorder.js';
import {
  createDemoSessionPair,
  demoState,
  FLEET_RUN_ROW_COST,
  type DemoState,
} from '../memory/demo.js';
import {
  authoriseLiveRun,
  liveBudget,
  liveCapabilityGranted,
  PUBLIC_REPLAY_REASON,
  type LiveAuthorisation,
} from '../memory/live-budget.js';
import type { RunScopes } from './run.js';
import { runScenario, type DemoArm } from './scenario.js';
import { readSqlLog, writeSqlLog } from './sql-log.js';

export interface DemoRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface DemoResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Field names that look like a credential.
 *
 * `05` §5 forbids one "in any field, under any name, on any path", and requires a
 * request carrying one to be **rejected rather than honoured** — ignoring it is not
 * enough, because the rule exists so that the field never appears to work. The moment a
 * `dsn` field appears to work, somebody pastes a live connection string into a
 * stranger's web form.
 *
 * `session` is not here and must not be: a session id is a public, ephemeral, scoped
 * identifier that the server minted and the browser is expected to send back. `auth`,
 * `token` and `arn` are, including nested, which is why the scan below recurses.
 */
const CREDENTIAL_KEY = /(dsn|conn(ection)?[_-]?string|passw(or)?d|secret|token|bearer|auth|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|arn|role)/i;

/**
 * Values that look like a credential whatever they are called. A visitor who names the
 * field `note` and pastes a connection string into it is the same failure as a `dsn`
 * field, and the same refusal.
 */
const CREDENTIAL_VALUE = /(postgres(ql)?:\/\/|sslmode=|\bsk-[a-z0-9]|\bAKIA[0-9A-Z]{8}|arn:aws:)/i;

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  // The SPA is served from CloudFront and this API from API Gateway, so every call the
  // browser makes is cross-origin. Anonymous and unauthenticated by design: there is no
  // cookie, no session credential and nothing to protect with an origin check.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  // A demo panel that renders a cached session's state is showing something that is not
  // true any more, which `04` §5 invariant 2 is about.
  'cache-control': 'no-store',
};

function json(statusCode: number, payload: unknown): DemoResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

/**
 * How the scenario embeds its statements. Installed by the caller so this module carries
 * no Bedrock dependency and `test/` can drive the whole route surface deterministically.
 */
let embedderFn: ((text: string) => Promise<number[]>) | undefined;

export function useEmbedder(embed: (text: string) => Promise<number[]>): void {
  embedderFn = embed;
}

function embedder(): (text: string) => Promise<number[]> {
  if (!embedderFn) throw new Error('no embedder installed: call useEmbedder() at start-up');
  return embedderFn;
}

/** One visitor's fleet run, as handed to whatever performs it. */
export interface RunJob {
  runId: string;
  scopes: RunScopes;
  /**
   * Present **only** when this route authorised a LIVE run and spent a slot for it. Absent is
   * the ordinary case and is what keeps an anonymous visitor's run free.
   *
   * It carries the capability the caller presented rather than a boolean, because the runner
   * receives this payload over an asynchronous Lambda invoke it cannot authenticate: a
   * `live: true` field would be a *claim*, and the runner re-comparing the token against its
   * own copy of the secret is what turns it into a proof. Two functions, one secret, checked
   * twice — see `liveCapabilityGranted`.
   */
  live?: { capability: string };
}

/**
 * How a fleet run is started. Installed by the caller for the same reason the embedder is: this
 * module decides *what the route does*, and "invoke another Lambda asynchronously" is an AWS fact
 * belonging to `infra/lambda/demo.ts`. `test/demo-plane.test.ts` installs a recorder instead and
 * so can assert the handoff — that both scopes and the run id the caller was given reach the
 * runner — against the real cluster without deploying anything.
 */
let runStarterFn: ((job: RunJob) => Promise<void>) | undefined;

export function useRunStarter(start: (job: RunJob) => Promise<void>): void {
  runStarterFn = start;
}

function runStarter(): (job: RunJob) => Promise<void> {
  if (!runStarterFn) throw new Error('no run starter installed: call useRunStarter() at start-up');
  return runStarterFn;
}

/** Walks a decoded request body looking for anything credential-shaped, at any depth. */
export function findCredentialField(value: unknown, path: string[] = []): string | null {
  if (typeof value === 'string' && CREDENTIAL_VALUE.test(value)) {
    return path.join('.') || '<body>';
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findCredentialField(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) return [...path, key].join('.');
      const found = findCredentialField(item, [...path, key]);
      if (found) return found;
    }
  }

  return null;
}

/**
 * RUNG 3 — the per-session row cap, `04` §5.
 *
 * "session becomes read-only; its rows, counters and SQL log stay inspectable; a new session
 * is one click." Two decisions are in this function and both are the rung rather than the
 * mechanism:
 *
 * - **It is a preflight, not a write-time check.** A cap enforced at the moment a statement
 *   would exceed it stops a run halfway through, leaving a page that was working a second ago
 *   showing half a fleet and no explanation. `04` §5 invariant 1 forbids an error page; a
 *   half-finished run is that failure wearing a 200.
 * - **It is not an error status.** `05` §5: "Every degradation rung MUST be expressible
 *   through these routes without an error status." So a capped session answers 200 with
 *   `started: false` and the reason, and every other route on that session goes on working —
 *   which is the "still inspectable" half of §5's row, and it holds because nothing here
 *   touches `GET /demo/state` or `GET /demo/sql-log`.
 */
function rungThree(
  scopes: { scope: string; state: DemoState }[],
): DemoResponse | null {
  const full = scopes.filter((s) => s.state.rows.remaining < FLEET_RUN_ROW_COST);
  if (full.length === 0) return null;

  return json(200, {
    started: false,
    rung: 3,
    reason:
      'This session has used its row budget, so it is read-only from here. Everything it ' +
      'already wrote is still on this page and still queryable — the rows, the counters and ' +
      'the SQL transcript are all unchanged. Starting a fresh session is one click and costs ' +
      'nothing.',
    rows: Object.fromEntries(full.map((s) => [s.scope, s.state.rows])),
    newSession: 'POST /demo/session',
  });
}

/**
 * RUNG 4 — the cluster or the write path is unreachable, `04` §5.
 *
 * Answered here rather than only in `infra/lambda/demo.ts` for the reason this whole module
 * exists: a rung that can only be exercised by deploying it is a rung that is exercised once.
 * `npm run gate:ladder` forces this one by pointing the demo plane at a host that is not
 * there, which is a thing a test can do and a deployed handler cannot.
 *
 * **It states that nothing is live, and that is invariant 2 rather than politeness.** §5's own
 * "what is still true" column for this rung reads "nothing is live, and the banner says so",
 * and `07` §4 repeats it: "A static fallback that silently depicts a live system would breach
 * rule A7 far more seriously than replayed reasoning does." The status stays 5xx on purpose —
 * this is the one case that is a fault rather than a limit, and the page's obligation is to
 * put the pre-recorded walkthrough behind an explicit banner rather than to pretend the run
 * happened.
 */
export function backendUnreachable(error: unknown): DemoResponse {
  const failure = error as { code?: string; message?: string };
  return json(503, {
    rung: 4,
    live: false,
    error: 'The demo backend could not reach its database. Nothing here is live right now.',
    banner:
      'The database behind this demo is unreachable, so nothing on this page is live. What ' +
      'follows is a pre-recorded walkthrough of a real run, not a run happening now.',
    // The code, never the message: a driver's message can carry the host it failed to reach,
    // and a connection string is the one thing that must never be echoed to a browser.
    ...(failure.code ? { code: failure.code } : {}),
  });
}

/**
 * Routes one request. Never throws for a limit or a missing session — `04` §5 invariant
 * 1 admits no error page on any path a visitor can reach, so an expired or unknown
 * session is a 404 carrying an explanation the SPA can render, and a genuine fault is
 * the only 5xx.
 */
export async function handleDemoRequest(request: DemoRequest): Promise<DemoResponse> {
  try {
    return await dispatch(request);
  } catch (error) {
    return backendUnreachable(error);
  }
}

async function dispatch(request: DemoRequest): Promise<DemoResponse> {
  if (request.method === 'OPTIONS') {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  }

  // **Both the body and the query string, and the query half was missing until 2026-08-13.**
  //
  // `/check` found it blind (V40): this scanned `request.body` alone, while
  // `infra/lambda/demo.ts` parses every query parameter and passes it in — so on the deployed
  // API a credential on the query string was ignored and the request honoured with a 200.
  // Nothing leaked, because the parameter was dropped rather than stored. What failed is the
  // half of `05` §5 that matters most here: **"rejected rather than honoured"**, on a rule that
  // reads "in any field, under any name, on any path". A dropped credential looks, to whoever
  // pasted it, exactly like an accepted one — which is the docstring above this file's
  // `CREDENTIAL_KEY`, and it was true of this handler while it said so.
  //
  // Query first, because it is the half that was unguarded and a test that passes for the
  // wrong reason is easier to write against the second branch.
  //
  // **The path is deliberately not scanned.** A path names a route, not a field; the router
  // already answers anything it does not recognise with a 404, so a credential there reaches
  // no handler and is echoed nowhere.
  const offending =
    findCredentialField(request.query ?? null, ['query']) ?? findCredentialField(request.body ?? null);

  if (offending) {
    return json(400, {
      error:
        'This demo never accepts a credential. No route takes a connection string, key, ' +
        'token or role, and the field carrying one was refused rather than ignored.',
      field: offending,
    });
  }

  const route = `${request.method} ${request.path}`;

  if (route === 'POST /demo/session') {
    // Two scopes since U22, one per arm (design §4.1), and additive: `sessionId` is the cortex
    // scope under the name it already had, so the deployed page reads the same field it always
    // read and never learns that anything changed.
    const session = await createDemoSessionPair();
    return json(200, {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
      scopes: session.scopes,
    });
  }

  if (route === 'GET /demo/state') {
    const sessionId = request.query?.['session'];
    if (!sessionId) {
      return json(400, { error: 'A session id is required. Start one at POST /demo/session.' });
    }

    const state = await demoState(sessionId);
    if (!state) {
      return json(404, {
        error: 'That session has expired or never existed. Starting a new one is one click.',
      });
    }

    /**
     * `05` §5: "The current mode, the reason for it, and the session's remaining row budget
     * MUST be readable by the SPA, so that the interface can render a degraded state
     * truthfully instead of discovering it through a failed request."
     *
     * The row budget has always been in `state.rows`. The LIVE half is added **only for a
     * caller holding design §7.1's capability**, and that is the §7.1 rule rather than
     * caution: without the token the response must be exactly what the public page gets, and
     * a `live` block appearing in every state response is precisely the hint that a gate
     * exists. The page that can offer a LIVE run is the page that needs to render rung 1
     * before the click; nobody else does.
     */
    if (liveCapabilityGranted(request.query?.['live'])) {
      const budget = await liveBudget();
      return json(200, {
        ...state,
        live: { ...budget, available: budget.remaining > 0 },
      });
    }

    return json(200, state);
  }

  if (route === 'POST /demo/run') {
    const body = (request.body ?? {}) as {
      session?: unknown;
      arm?: unknown;
      mode?: unknown;
      naive?: unknown;
    };
    const sessionId = typeof body.session === 'string' ? body.session : request.query?.['session'];
    if (!sessionId) {
      return json(400, { error: 'A session id is required. Start one at POST /demo/session.' });
    }

    // Only two values are accepted, and neither reaches SQL. `07` §4's honesty rule and
    // invariant 7 both point the same way: an arm is a fixed choice between two code
    // paths, not a parameter the caller gets to shape.
    const arm: DemoArm = body.arm === 'naive' ? 'naive' : 'cortex';

    /**
     * THE ONE THING U22 ADDED TO THIS SURFACE, AND WHY IT IS NOT A SIXTH ROUTE.
     *
     * `mode` is `arm`'s twin: two accepted values, decided against a closed set, neither of which
     * reaches SQL or names a table. The default is the four scripted beats this route has always
     * performed, because the **deployed page consumes that response today** and design decision 7
     * keeps it serving until U26's cold read. `fleet` is U21's ten-ticket two-arm run, which is
     * handed off and answered with a run id rather than performed on this response — see
     * `src/demo/run.ts` for why, and for the design premise V51 measured to be false.
     *
     * A sixth route was the obvious alternative and design §8 had already refused one for a weaker
     * reason — the artifacts go through `GET /demo/state` "rather than a sixth route, so `05` §5's
     * route list does not grow". When U25 rebuilds the page, the beats branch goes and this route
     * keeps its name.
     */
    const mode = body.mode === 'fleet' ? 'fleet' : 'beats';

    const state = await demoState(sessionId);
    if (!state) {
      return json(404, {
        error: 'That session has expired or never existed. Starting a new one is one click.',
      });
    }

    if (mode === 'fleet') {
      // Both scopes are the caller's own, minted together by `POST /demo/session`, and each is
      // validated on its own rather than inferred from the other. They cannot be looked up from
      // one another: `04` §3's policy confines a connection to the scope it names, so a
      // connection scoped to the cortex row cannot read the naive row to discover it — which is
      // the confinement working, not an obstacle to route around.
      const naiveScope = typeof body.naive === 'string' ? body.naive : undefined;
      if (!naiveScope) {
        return json(400, {
          error:
            'A fleet run needs both of the session\'s scopes. POST /demo/session returns them as ' +
            'scopes.cortex and scopes.naive; pass the second one as "naive".',
        });
      }

      const naiveState = await demoState(naiveScope);
      if (!naiveState) {
        return json(404, {
          error: 'That session has expired or never existed. Starting a new one is one click.',
        });
      }

      // Rung 3, on both of the visitor's scopes. Each has its own budget (design §4.1), and a
      // run that could finish one arm and not the other is the half-finished page this rung
      // exists to prevent.
      const capped = rungThree([
        { scope: sessionId, state },
        { scope: naiveScope, state: naiveState },
      ]);
      if (capped) return capped;

      /**
       * RUNG 1 AND THE CAPABILITY, IN THE ORDER THAT MAKES THEM SAFE.
       *
       * The token is checked first and the budget is only spent for a caller that holds it, so
       * an anonymous visitor cannot drain the day's runs by clicking. A caller without the
       * token gets `replay` and `PUBLIC_REPLAY_REASON`, which names no quota and no
       * capability — design §7.1: "no error, no hint that a gate exists".
       *
       * A caller *with* the token gets whatever the counter says, and exhaustion is a normal
       * return value carrying rung 1's sentence rather than a failure. `05` §5 is explicit:
       * "POST /demo/run MUST NOT fail when the LIVE quota is exhausted. It returns a replay
       * run together with the reason it is not live."
       */
      const presented = request.query?.['live'];
      const authorisation: LiveAuthorisation | null = liveCapabilityGranted(presented)
        ? await authoriseLiveRun()
        : null;
      const live = authorisation?.mode === 'live';

      const runId = randomUUID();
      await runStarter()({
        runId,
        scopes: { cortex: sessionId, naive: naiveScope },
        // The presented value, not a flag, and only once a slot has actually been taken.
        ...(live && presented ? { live: { capability: presented } } : {}),
      });

      // 202, because the honest answer is "accepted" and not "done". Everything the run does
      // arrives over the WebSocket, terminal event included — see `src/demo/run.ts` for why a
      // run that ends without one is the failure this unit was written about.
      return json(202, {
        runId,
        mode: 'fleet',
        started: true,
        scopes: { cortex: sessionId, naive: naiveScope },
        stream: 'Every step of the run arrives over the WebSocket, ending with a run message.',
        /**
         * `07` §4's mode line, as a value the page renders rather than a string it hard-codes.
         * Never the token, and never a field named for one — the capability is compared and
         * then forgotten.
         */
        reasoning: {
          mode: authorisation ? authorisation.mode : ('replay' as const),
          reason: authorisation ? authorisation.reason : PUBLIC_REPLAY_REASON,
          // Rung 1 is *named* only when it actually fired, so a page cannot render a
          // degradation banner on an ordinary run.
          ...(authorisation && authorisation.mode === 'replay' ? { rung: 1 } : {}),
          ...(authorisation
            ? {
                live: {
                  used: authorisation.used,
                  cap: authorisation.cap,
                  remaining: authorisation.remaining,
                },
              }
            : {}),
        },
      });
    }

    // Rung 3 again, for the four-beat path. It writes fewer rows than a fleet run, so this is
    // the conservative side of one constant rather than a second measurement — and the path is
    // still reachable by a scripted caller, which is the case the cap is for.
    const beatsCapped = rungThree([{ scope: sessionId, state }]);
    if (beatsCapped) return beatsCapped;

    const recorder = new StatementRecorder();
    const result = await runScenario({
      sessionId,
      arm,
      embed: (text) => embedder()(text),
      recorder,
    });

    await writeSqlLog({
      sessionId,
      arm,
      recordedAt: new Date().toISOString(),
      statements: recorder.statements,
    });

    return json(200, {
      ...result,
      sql: { statements: recorder.statements.length, at: '/demo/sql-log' },
    });
  }

  if (route === 'GET /demo/sql-log') {
    const sessionId = request.query?.['session'];
    if (!sessionId) return json(400, { error: 'A session id is required.' });

    const log = await readSqlLog(sessionId);
    if (!log) {
      // Not an error: a session that has not run the scenario has executed no statements,
      // and an empty transcript is the truthful answer. `04` §5 invariant 1 forbids an
      // error page on any path a visitor can reach, and this is one click away.
      return json(200, { sessionId, arm: null, recordedAt: null, statements: [] });
    }

    return json(200, log);
  }

  return json(404, { error: 'No such route.' });
}
