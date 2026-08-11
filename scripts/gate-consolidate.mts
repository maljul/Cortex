/**
 * Beat 4, proven end to end: a closed intent becomes a durable finding, and the finding
 * arrives over the same change stream that carried the close.
 *
 *   npm run gate:consolidate
 *
 * `07` §3 beat 4 is "a closed intent becomes a durable finding a moment later, arriving
 * via the change stream", and A7 requires the project to function as depicted — so this
 * is the check that the beat can be animated honestly. Nothing here is simulated: the
 * intent is proposed and closed through `src/memory/`, CockroachDB's own changefeed
 * carries the transition to the deployed sink, the sink embeds via Bedrock and writes the
 * finding, and the finding's insert is itself a row change that comes back to the socket.
 *
 * Run it after `npm run changefeed status` shows a running job.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

import { closePool } from '../src/db/pool.js';
import { close } from '../src/memory/close.js';
import { createDemoSession } from '../src/memory/demo.js';
import { propose } from '../src/memory/propose.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const STACK = 'CortexStack';
/** Consolidation is a changefeed hop plus a cold Bedrock call. Seconds, not milliseconds. */
const ARRIVAL_TIMEOUT_MS = 120_000;

function streamUrl(): string {
  const result = spawnSync(
    'aws',
    [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      STACK,
      '--query',
      "Stacks[0].Outputs[?OutputKey=='StreamUrl'].OutputValue",
      '--output',
      'text',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`describe-stacks failed: ${result.stderr}`);
  return result.stdout.trim();
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

/** A deterministic unit vector, so the gate needs no embedding call of its own. */
function unitVector(seed: number): number[] {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const raw = Array.from({ length: 1024 }, () => next() * 2 - 1);
  const magnitude = Math.hypot(...raw);
  return raw.map((c) => c / magnitude);
}

async function main(): Promise<void> {
  const stream = streamUrl();
  const session = await createDemoSession();
  console.log(`session ${session.sessionId}`);
  console.log(`stream  ${stream}\n`);

  const socket = new WebSocket(`${stream}?session=${session.sessionId}`);
  const seen: { topic: string; after: Record<string, unknown> | null }[] = [];
  socket.addEventListener('message', (event) => {
    seen.push(JSON.parse(String((event as MessageEvent).data)));
  });
  await new Promise<void>((ready, fail) => {
    socket.addEventListener('open', () => ready());
    socket.addEventListener('error', () => fail(new Error('could not open the socket')));
  });

  const NOTES = `the retry belongs in the client — gate ${new Date().toISOString()}`;

  // Propose and close on the demo plane, exactly as the SPA's scenario will.
  const decision = await propose({
    repoId: session.sessionId,
    agentId: 'gate-agent',
    statement: 'add a retry to the orders client',
    resourceKeys: ['file:src/orders/client.ts'],
    embedding: unitVector(4242),
    plane: 'demo',
    demoSession: session.sessionId,
  });
  check('1. intent granted', decision.decision === 'granted', decision.decision);
  if (decision.decision !== 'granted') throw new Error('nothing to close');

  await close({
    repoId: session.sessionId,
    intentId: decision.intentId,
    result: 'done',
    idempotencyKey: `gate-consolidate-${decision.intentId}`,
    notes: NOTES,
    plane: 'demo',
    demoSession: session.sessionId,
  });
  check('2. intent closed as done', true, decision.intentId);

  // 3. The consolidated finding, which the sink wrote and the changefeed brought back.
  const startedAt = Date.now();
  let finding: Record<string, unknown> | undefined;
  while (Date.now() - startedAt < ARRIVAL_TIMEOUT_MS) {
    finding = seen.find((m) => m.topic === 'findings' && m.after?.['fact'] === NOTES)?.after ?? undefined;
    if (finding) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  check(
    '3. finding arrived over the change stream',
    finding !== undefined,
    finding ? `${Date.now() - startedAt}ms` : `nothing in ${ARRIVAL_TIMEOUT_MS}ms`,
  );

  if (finding) {
    check(
      '4. it names the intent it came from',
      finding['source_intent_id'] === decision.intentId,
      String(finding['source_intent_id']),
    );
    console.log(`\nfact: ${String(finding['fact'])}`);
    console.log(`confidence ${String(finding['confidence'])}  corroborations ${String(finding['corroborations'])}`);
  }

  socket.close();

  const admin = new Client({
    connectionString: process.env['CORTEX_DSN'],
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  for (const table of ['findings', 'claims', 'action_ledger', 'intents', 'agents']) {
    await admin.query(`DELETE FROM ${table} WHERE repo_id = $1`, [session.sessionId]);
  }
  await admin.query('DELETE FROM repos WHERE id = $1', [session.sessionId]);
  await admin.end();
  await closePool();

  console.log(failures === 0 ? '\nGATE PASSED' : `\nGATE FAILED — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
