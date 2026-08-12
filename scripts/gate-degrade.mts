/**
 * RUNG 2, FORCED — spec/04-ARCHITECTURE.md §5's degradation ladder.
 *
 *   npm run gate:degrade
 *
 * §5 invariant 4: "Every rung MUST be verified by forcing its limit, not by reasoning about
 * it." This forces rung 2's limit the only way it can honestly be forced without waiting for
 * AWS to throttle us — by making the embedder refuse — and then checks the four things §5's
 * ladder row actually promises:
 *
 *   1. the run produces a working page rather than an error (invariant 1)
 *   2. the vector used is the deterministic local one
 *   3. dedupe is skipped, and the show-SQL transcript proves it rather than asserting it
 *   4. every intent written is marked in the database, and the page says what degraded
 *
 * §5 singles this rung out: "rung 2 is reachable in REPLAY as well as in LIVE. REPLAY caches
 * reasoning, not embeddings, so the demo retains a Bedrock dependency even with LIVE disabled
 * entirely. This is the rung most likely to fire unnoticed." That is why it is the first rung
 * U17 built and the first one with a gate.
 *
 * Everything below runs against the **real cluster** as the **real `cortex_demo` principal**,
 * inside a real demo session scope. The only thing faked is the failure being forced, which
 * is the point of a gate.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from 'pg';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder } from '../src/db/recorder.js';
import { runScenario } from '../src/demo/scenario.js';
import { degradedEmbedding } from '../src/embed/degraded.js';
import { createDemoSession } from '../src/memory/demo.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Bedrock, refusing. The shape the SDK raises when the account is over its rate. */
async function throttled(): Promise<number[]> {
  throw Object.assign(new Error('Too many requests, please wait before trying again.'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 429 },
  });
}

async function main(): Promise<void> {
  const session = await createDemoSession();
  const recorder = new StatementRecorder();

  console.log(`forcing rung 2 in demo session ${session.sessionId}`);
  console.log('every embedding call will be refused with ThrottlingException\n');

  const started = Date.now();
  let result: Awaited<ReturnType<typeof runScenario>> | null = null;
  let threw: unknown = null;

  try {
    result = await runScenario({
      sessionId: session.sessionId,
      arm: 'cortex',
      embed: throttled,
      recorder,
    });
  } catch (error) {
    threw = error;
  }

  check(
    'the run produced a page, not an error (§5 invariant 1)',
    threw === null && result !== null,
    threw === null ? `${Date.now() - started}ms` : `threw ${(threw as Error).name}`,
  );

  if (!result) {
    await closePool();
    process.exit(1);
  }

  check(
    'the page reports rung 2 and how much degraded',
    result.degraded?.rung === 2 && (result.degraded?.embeddings ?? 0) > 0,
    `${result.degraded?.embeddings ?? 0} embedding calls refused`,
  );

  check(
    'the reason names dedupe as degraded and the database as live (§5 invariant 2)',
    /dedupe/i.test(result.degraded?.reason ?? '') &&
      /CockroachDB|database/i.test(result.degraded?.reason ?? ''),
    '',
  );

  const searches = recorder.statements.filter((s) => s.sql.includes('<=>') && /FROM intents/i.test(s.sql));
  check(
    'no similarity search reached the driver — dedupe was skipped, per the transcript',
    searches.length === 0,
    `${searches.length} found in ${recorder.statements.length} statements`,
  );

  const beats = new Set(result.steps.map((s) => s.beat));
  check(
    'the beats still ran',
    beats.size >= 3,
    `beats present: ${[...beats].sort().join(', ')}`,
  );

  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 15_000,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ total: string; marked: string }>(
      `SELECT count(*)::INT AS total,
              count(*) FILTER (WHERE embedding_degraded)::INT AS marked
         FROM intents WHERE repo_id = $1`,
      [session.sessionId],
    );
    const total = Number(rows[0]?.total ?? 0);
    const marked = Number(rows[0]?.marked ?? 0);

    check(
      'every intent it wrote is marked degraded in the database',
      total > 0 && total === marked,
      `${marked}/${total} marked`,
    );

    // The vector that reached the column is the deterministic one, checked by asking the
    // cluster to compare what it stored against what this process would generate. A hash
    // vector that did not survive the round trip would be a silently different embedding.
    const expected = `[${degradedEmbedding(
      'add a retry to the orders client',
    ).join(',')}]`;
    const { rows: near } = await admin.query<{ dist: number }>(
      `SELECT embedding <=> $2 AS dist FROM intents
        WHERE repo_id = $1 AND statement = 'add a retry to the orders client' LIMIT 1`,
      [session.sessionId, expected],
    );
    check(
      'the stored vector is the deterministic local one, round trip included',
      near[0] !== undefined && Number(near[0].dist) < 1e-6,
      near[0] === undefined ? 'no such intent' : `distance ${Number(near[0].dist).toExponential(2)}`,
    );
  } finally {
    await admin.query('DELETE FROM action_ledger WHERE repo_id = $1', [session.sessionId]);
    await admin.query('DELETE FROM findings WHERE repo_id = $1', [session.sessionId]);
    await admin.query('DELETE FROM claims WHERE repo_id = $1', [session.sessionId]);
    await admin.query('DELETE FROM intents WHERE repo_id = $1', [session.sessionId]);
    await admin.query('DELETE FROM repos WHERE id = $1', [session.sessionId]);
    await admin.end();
  }

  console.log(`\n${result.degraded?.reason ?? '(no reason reported)'}\n`);
  await closePool();

  if (failures > 0) {
    console.log(`${failures} check(s) failed — rung 2 does not hold.`);
    process.exit(1);
  }
  console.log('rung 2 holds: the limit was forced and the page still works.');
}

await main();
