/**
 * U22'S GATE — "`POST /demo/run` returns inside the gateway ceiling and the whole run arrives
 * over the socket."
 *
 *   npm run gate:async
 *
 * That sentence is the unit's done-when, verbatim from design §11, and it is a sentence about the
 * *deployed* stack: a gateway ceiling only exists behind API Gateway, and a socket only carries a
 * run if a second Lambda is genuinely invoked. So this is a script rather than a test, for the
 * same reason `npm run gate:stream` is.
 *
 * What it does, in the order a visitor would:
 *
 *   1. asks the hosted API for a session — two scopes now, one per arm (design §4.1)
 *   2. opens the WebSocket the page opens, filtered to the cortex scope
 *   3. posts the fleet run and **times the response**, against the measured 30,000ms ceiling
 *   4. reads the whole run off the socket, ending at the terminal message
 *
 * **Step 4 is the unit's named silent break, checked from the outside.** A run that dies after
 * the 202 has already gone out leaves a page that never finishes and never errors. The gate
 * therefore fails on a missing terminal message, on more than one, and on anything arriving
 * after it — and it fails on a *silent* run just as hard as on a broken one, because a timeout
 * here is exactly what a visitor would experience as the page hanging.
 *
 * **A changefeed job must be running**, or beat 4 honestly reports nothing known and the run's
 * own summary says so. `npm run changefeed status`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const STACK = 'CortexStack';

/**
 * API Gateway HTTP's integration timeout on this deployment.
 *
 * **V51 tried to force it with a real run and could not**, which is the more useful result: design
 * §5.1 assumed a two-arm run would exceed this, and deployed in-region it takes 5.9–8.3s. A
 * synchronous invocation was deployed on purpose to find out and answered in 4548ms. So this
 * number is the boundary the route must stay inside, and the check below is a regression guard
 * rather than a demonstration — if a run ever does approach it, `04` §5 invariant 1 is what breaks,
 * because a 504 is a gateway error page on a path behind the run button.
 */
const GATEWAY_CEILING_MS = 30_000;

/**
 * A deployed run is 5.9–8.3s (V51). This is twenty times that, so a failure here means the run
 * stalled or died silently — which is the thing the gate exists to catch — rather than that the
 * cluster was having a slow morning.
 */
const RUN_TIMEOUT_MS = 150_000;

function stackOutputs(): Record<string, string> {
  const result = spawnSync(
    'aws',
    ['cloudformation', 'describe-stacks', '--stack-name', STACK, '--query', 'Stacks[0].Outputs', '--output', 'json'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`describe-stacks failed: ${result.stderr}`);

  const entries = JSON.parse(result.stdout) as { OutputKey: string; OutputValue: string }[];
  return Object.fromEntries(entries.map((o) => [o.OutputKey, o.OutputValue]));
}

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
}

interface AnyMessage {
  type?: string;
  phase?: string;
  runId?: string;
  scope?: string;
  event?: { arm: string; agent: string; taskId: string; phase: string; seq: number };
  arms?: { arm: string; events: number; beats: Record<string, boolean>; meter: Record<string, unknown> }[];
  reason?: string;
  undelivered?: number;
}

async function purge(scopes: string[]): Promise<void> {
  const admin = new Client({
    connectionString: process.env['CORTEX_DSN'],
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    for (const scope of scopes) {
      for (const table of ['claims', 'intents', 'findings', 'action_ledger', 'agents']) {
        await admin.query(`DELETE FROM ${table} WHERE repo_id = $1`, [scope]);
      }
      await admin.query('DELETE FROM repos WHERE id = $1', [scope]);
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  const outputs = stackOutputs();
  const api = outputs['ApiUrl'];
  const stream = outputs['StreamUrl'];
  if (!api || !stream) throw new Error(`${STACK} has no ApiUrl / StreamUrl. Deploy it first.`);

  console.log(`api    ${api}`);
  console.log(`stream ${stream}\n`);

  // 1. A session, exactly as an anonymous visitor gets one, and two scopes out of it.
  const created = await fetch(`${api}/demo/session`, { method: 'POST' });
  const session = (await created.json()) as {
    sessionId: string;
    scopes?: { cortex: string; naive: string };
  };
  const scopes = session.scopes;
  check(
    '1. session created anonymously, with two scopes',
    created.status === 200 &&
      scopes !== undefined &&
      scopes.cortex === session.sessionId &&
      scopes.naive !== scopes.cortex,
    scopes ? `cortex ${scopes.cortex.slice(0, 8)} naive ${scopes.naive.slice(0, 8)}` : 'no scopes',
  );
  if (!scopes) {
    console.log('\nGATE FAILED — the session route did not return two scopes');
    process.exit(1);
  }

  // 2. One socket, on the cortex scope, exactly as a page holds one. The runner broadcasts a
  //    run's messages to both of a visitor's scopes precisely so that this is enough.
  const socket = new WebSocket(`${stream}?session=${scopes.cortex}`);
  const received: AnyMessage[] = [];
  let terminalAt = -1;

  const finished = new Promise<void>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`no terminal message within ${RUN_TIMEOUT_MS}ms — this is the silent break`)),
      RUN_TIMEOUT_MS,
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as AnyMessage;
      received.push(message);

      if (message.type === 'fleet' && message.event) {
        const e = message.event;
        console.log(`    ${e.arm.padEnd(6)} ${e.agent} ${e.taskId.padEnd(4)} ${e.phase}`);
      }

      if (message.type === 'run' && (message.phase === 'finished' || message.phase === 'failed')) {
        if (terminalAt === -1) terminalAt = received.length - 1;
        clearTimeout(timer);
        // Deliberately not resolved at once: anything arriving *after* the terminal message is a
        // defect, and the only way to see it is to keep listening for a moment.
        setTimeout(() => done(), 3_000);
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      fail(new Error('socket error'));
    });
  });

  await new Promise<void>((ready, fail) => {
    socket.addEventListener('open', () => ready());
    socket.addEventListener('error', () => fail(new Error('could not open the socket')));
  });
  check('2. socket open, filtered to the cortex scope', socket.readyState === WebSocket.OPEN);

  // 3. The run, and the number the done-when is about.
  const postedAt = Date.now();
  const response = await fetch(`${api}/demo/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: scopes.cortex, mode: 'fleet', naive: scopes.naive }),
  });
  const accepted = (await response.json()) as { runId?: string };
  const responseMs = Date.now() - postedAt;

  check(
    '3. POST /demo/run accepted the run',
    response.status === 202 && /^[0-9a-f-]{36}$/.test(accepted.runId ?? ''),
    `${response.status} ${accepted.runId ?? ''}`,
  );
  check(
    `3b. returned inside the gateway ceiling (${GATEWAY_CEILING_MS}ms)`,
    responseMs < GATEWAY_CEILING_MS,
    `${responseMs}ms`,
  );

  // 4. The whole run, over the socket.
  console.log('\n  the run, as it arrives:');
  let stalled: string | null = null;
  try {
    await finished;
  } catch (error) {
    stalled = (error as Error).message;
  }
  socket.close();

  const runMs = Date.now() - postedAt;
  const fleet = received.filter((m) => m.type === 'fleet');
  const terminals = received.filter(
    (m) => m.type === 'run' && (m.phase === 'finished' || m.phase === 'failed'),
  );
  const terminal = terminals[0];

  console.log('');
  check('4. the run terminated rather than going silent', stalled === null, stalled ?? `${runMs}ms`);
  check('4b. exactly one terminal message', terminals.length === 1, `${terminals.length}`);
  check(
    '4c. nothing arrived after it',
    terminalAt === -1 || terminalAt === received.length - 1,
    terminalAt === -1 ? 'no terminal' : `${received.length - 1 - terminalAt} after`,
  );
  check('4d. it finished rather than failing', terminal?.phase === 'finished', terminal?.reason ?? '');

  check(
    '5. both arms streamed their agents',
    new Set(fleet.map((m) => m.event?.arm)).size === 2,
    [...new Set(fleet.map((m) => m.event?.arm))].join(' '),
  );
  check('5b. every step arrived', fleet.length > 0, `${fleet.length} fleet events`);
  check(
    '5c. the summary agrees with what was streamed',
    terminal?.arms !== undefined &&
      terminal.arms.reduce((n, a) => n + a.events, 0) === fleet.length,
    terminal?.arms ? `${terminal.arms.reduce((n, a) => n + a.events, 0)} claimed` : '',
  );
  check('5d. nothing was undelivered', terminal?.undelivered === 0, `${terminal?.undelivered}`);

  /**
   * Design §5.3. The changefeed's messages are rows and carry their own primary key; a fleet
   * event is not a row and nothing may imply it is. Both sources arrive on this one socket, so
   * this is where a page could be misled and where the labelling has to hold.
   */
  const changes = received.filter((m) => m.type === 'change');
  check(
    '6. fleet events are labelled apart from changefeed rows',
    fleet.every((m) => !('after' in m) && !('topic' in m) && !('key' in m)),
    `${changes.length} real rows also arrived on the same socket`,
  );

  if (terminal?.arms) {
    console.log('\n  SUMMARY');
    for (const arm of terminal.arms) {
      const beats = Object.entries(arm.beats)
        .map(([name, fired]) => `${name}${fired ? '✓' : '✗'}`)
        .join(' ');
      const m = arm.meter as Record<string, unknown>;
      console.log(
        `    ${arm.arm.padEnd(6)} ${String(arm.events).padStart(3)} events   ${beats}` +
          `   conflicting ${m['conflictingEdits']} · collisions ${m['fileCollisions']}`,
      );
    }
  }
  console.log(`\n  wall clock: response ${responseMs}ms, whole run ${runMs}ms`);

  await purge([scopes.cortex, scopes.naive]);

  console.log(failures === 0 ? '\nGATE PASSED' : `\nGATE FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
