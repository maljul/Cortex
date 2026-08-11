/**
 * U14's gate: a row committed on the cluster reaches an anonymous browser's socket.
 *
 *   npm run gate:stream
 *
 * V25 established that Basic tier permits a webhook changefeed and that the job starts.
 * It deliberately did **not** claim delivery — its sink was a GET-only route, so a post
 * would have met a 404 — and recorded that a `running` job is not a delivered message.
 * This is the check that closes that gap, and it is a script rather than a test because
 * it needs the deployed stack, a changefeed job and a real socket, none of which belong
 * in `npm test`.
 *
 * What it does, in the order a visitor would:
 *
 *   1. asks the hosted API for a session, anonymously, with no credential
 *   2. opens the WebSocket the SPA opens, filtered to that session
 *   3. writes one row into that scope as `cortex_demo`, through `withRetry`
 *   4. waits for the cluster's changefeed to deliver that row to the socket
 *
 * Step 3 is a real write on the real cluster through the real confinement, not an
 * injected message: what step 4 receives has been through CockroachDB's changefeed, the
 * webhook sink, the auth header and the scope check. That is the whole claim.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

import { closePool } from '../src/db/pool.js';
import { withRetry } from '../src/db/retry.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const STACK = 'CortexStack';
/** Generous: a changefeed's end-to-end latency is seconds, not milliseconds. */
const DELIVERY_TIMEOUT_MS = 90_000;

function stackOutputs(): Record<string, string> {
  const result = spawnSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      STACK,
      '--query',
      'Stacks[0].Outputs',
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`describe-stacks failed: ${result.stderr}`);

  const entries = JSON.parse(result.stdout) as { OutputKey: string; OutputValue: string }[];
  return Object.fromEntries(entries.map((o) => [o.OutputKey, o.OutputValue]));
}

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${detail}`);
}

async function main(): Promise<void> {
  const outputs = stackOutputs();
  const api = outputs['ApiUrl'];
  const stream = outputs['StreamUrl'];
  if (!api || !stream) throw new Error(`${STACK} has no ApiUrl / StreamUrl. Deploy it first.`);

  console.log(`api    ${api}`);
  console.log(`stream ${stream}\n`);

  // 1. A session, exactly as an anonymous visitor gets one. No header, no credential.
  const created = await fetch(`${api}/demo/session`, { method: 'POST' });
  const session = (await created.json()) as { sessionId: string; expiresAt: string };
  check(
    '1. session created anonymously',
    created.status === 200 && /^[0-9a-f-]{36}$/.test(session.sessionId ?? ''),
    `${created.status} ${session.sessionId}`,
  );

  const socket = new WebSocket(`${stream}?session=${session.sessionId}`);
  const delivered = new Promise<string>((resolveMessage, rejectMessage) => {
    const timer = setTimeout(
      () => rejectMessage(new Error(`no message within ${DELIVERY_TIMEOUT_MS}ms`)),
      DELIVERY_TIMEOUT_MS,
    );
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      resolveMessage(String((event as MessageEvent).data));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      rejectMessage(new Error('socket error'));
    });
  });

  await new Promise<void>((ready, fail) => {
    socket.addEventListener('open', () => ready());
    socket.addEventListener('error', () => fail(new Error('could not open the socket')));
  });
  check('2. socket open, filtered to the session', socket.readyState === WebSocket.OPEN, stream);

  // 3. One real write, as `cortex_demo`, scoped by the same mechanism every other demo
  // statement uses. The marker makes the delivered message identifiable as this one.
  const marker = `gate-stream ${new Date().toISOString()}`;
  await withRetry(
    async (client) => {
      await client.query(
        `INSERT INTO findings (repo_id, fact, embedding)
         VALUES ($1, $2, $3::VECTOR)`,
        [session.sessionId, marker, `[${new Array(1024).fill(0).join(',')}]`],
      );
    },
    { plane: 'demo', demoSession: session.sessionId },
  );
  check('3. row committed as cortex_demo', true, marker);

  // 4. The cluster's own changefeed carries it to the socket.
  const startedAt = Date.now();
  try {
    const message = await delivered;
    const parsed = JSON.parse(message) as { topic: string; scope: string; after: { fact?: string } };
    check(
      '4. delivered over the changefeed',
      parsed.after?.fact === marker && parsed.scope === session.sessionId,
      `${Date.now() - startedAt}ms  topic=${parsed.topic}`,
    );
    console.log(`\n${message}\n`);
  } catch (error) {
    check('4. delivered over the changefeed', false, (error as Error).message);
  }

  socket.close();

  // Housekeeping, as the admin principal: the scope would expire by itself, but a gate
  // that can be run repeatedly should not leave a row behind each time.
  const admin = new Client({
    connectionString: process.env['CORTEX_DSN'],
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  await admin.query('DELETE FROM findings WHERE repo_id = $1', [session.sessionId]);
  await admin.query('DELETE FROM repos WHERE id = $1', [session.sessionId]);
  await admin.end();
  await closePool();

  console.log(failures === 0 ? '\nGATE PASSED' : `\nGATE FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
