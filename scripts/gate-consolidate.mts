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

  /**
   * THE ABANDONED HALF, AND IT EXISTS BECAUSE DEPLOYING V39 PROVED NOTHING WITHOUT IT.
   *
   * `03` §4.4 said consolidation fires on rows transitioning to `done`, and V39 widened
   * `CONSOLIDATES` to `done` **and** `abandoned` — the fleet's most expensive knowledge was
   * being written down and reached by nobody. That change went to `ChangefeedFn` on
   * 2026-08-13, and everything above would have passed identically before and after it,
   * because everything above closes as `done`. `CLAUDE.md` said so in as many words: the gate
   * "would still pass today because it exercises a `done` intent, so it is not evidence either
   * way". A deploy nobody can distinguish from the absence of a deploy is not a verified one.
   *
   * So: abandon an intent and require the finding to come back over the same socket.
   */
  const ABANDON_NOTES = `the provider has no sandbox for refunds — gate ${new Date().toISOString()}`;
  const ABANDON_STATEMENT = 'add refund support to the payments provider';

  const abandoned = await propose({
    repoId: session.sessionId,
    agentId: 'gate-agent-2',
    statement: ABANDON_STATEMENT,
    // A different file, so this is not contending with the claim above and a `blocked`
    // result cannot be mistaken for the mechanism failing.
    resourceKeys: ['file:src/payments/provider.ts'],
    // Far from the first intent's vector: dedupe must not fire, or nothing is abandoned and
    // the check below would pass on an empty premise.
    embedding: unitVector(9137),
    plane: 'demo',
    demoSession: session.sessionId,
  });
  check('5. second intent granted', abandoned.decision === 'granted', abandoned.decision);

  if (abandoned.decision === 'granted') {
    await close({
      repoId: session.sessionId,
      intentId: abandoned.intentId,
      result: 'abandoned',
      idempotencyKey: `gate-consolidate-abandon-${abandoned.intentId}`,
      notes: ABANDON_NOTES,
      plane: 'demo',
      demoSession: session.sessionId,
    });
    check('6. intent closed as abandoned', true, abandoned.intentId);

    const abandonStart = Date.now();
    let abandonFinding: Record<string, unknown> | undefined;
    while (Date.now() - abandonStart < ARRIVAL_TIMEOUT_MS) {
      abandonFinding =
        seen.find((m) => m.topic === 'findings' && m.after?.['fact'] === ABANDON_NOTES)?.after ??
        undefined;
      if (abandonFinding) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // The one that would have been false before the deploy. On the old filter the sink
    // returns null for an abandoned row, no finding is ever written, and nothing arrives.
    check(
      '7. an ABANDONED intent also consolidated (V39, live)',
      abandonFinding !== undefined,
      abandonFinding ? `${Date.now() - abandonStart}ms` : `nothing in ${ARRIVAL_TIMEOUT_MS}ms`,
    );

    if (abandonFinding) {
      check(
        '8. it names the abandoned intent',
        abandonFinding['source_intent_id'] === abandoned.intentId,
        String(abandonFinding['source_intent_id']),
      );
      // What is stored is the obstacle; what it is *found by* is the work. V39 measured the
      // gap at 0.6725-0.7246 against 0.4698-0.4899 — embed the reason and the memory is
      // unreachable by the task it exists to warn. This asserts the stored half; the
      // embedded half is `test/consolidate.test.ts`'s, which can see the vector.
      console.log(`\nabandoned fact: ${String(abandonFinding['fact'])}`);
      console.log(`  retrieval key would be: ${ABANDON_STATEMENT} — abandoned`);
    }
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
