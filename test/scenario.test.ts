/**
 * THE FOUR BEATS ACTUALLY HAPPEN — spec/07-DEMO-AND-SUBMISSION.md §3.
 *
 * U16's done-when is that the beats read clearly to someone who has not seen the project,
 * and rule A7 requires the project to **function as depicted**. A demo that animates a
 * dedupe it did not perform fails A7 no matter how clearly it reads, so this file asserts
 * the decisions rather than the presentation: `deduped` because `propose()` deduped,
 * `blocked` because a claim was held, a recalled finding because `recall()` returned one.
 *
 * The NAIVE half is asserted just as hard. `07` §2 calls the toggle the demo's spine —
 * "same scenario, same cassettes, visibly different outcome" — and a NAIVE arm that merely
 * printed worse numbers would be the same lie pointed the other way.
 *
 * Embeddings here are deterministic test vectors rather than Bedrock calls: the beats turn
 * on *distances*, and the tests need to control them exactly. That the real statements
 * separate under Titan is the deployed gate's job (`npm run gate:beats`), not this file's.
 */
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder } from '../src/db/recorder.js';
import { SCRIPT, runScenario } from '../src/demo/scenario.js';
import { createDemoSession } from '../src/memory/demo.js';

import { paraphraseOf, vector } from './helpers/vectors.js';

const sessions: string[] = [];

async function session(): Promise<string> {
  const created = await createDemoSession();
  sessions.push(created.sessionId);
  return created.sessionId;
}

/**
 * Deterministic embeddings that reproduce the semantic relationships the script depends
 * on: the two beat-2 statements are paraphrases and must land inside the dedupe threshold;
 * everything else is near-orthogonal and must not.
 */
async function embed(text: string): Promise<number[]> {
  const base = vector(700);
  if (text === SCRIPT.dedupeHolder.statement) return base;
  if (text === SCRIPT.dedupeCaller.statement) return paraphraseOf(base, 701, 0.02);
  if (text === SCRIPT.seedFact) return paraphraseOf(base, 702, 0.06);

  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return vector(Math.abs(hash) % 10_000);
}

afterAll(async () => {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  for (const id of sessions) {
    for (const table of ['claims', 'action_ledger', 'findings', 'intents', 'agents']) {
      await admin.query(`DELETE FROM ${table} WHERE repo_id = $1`, [id]);
    }
    await admin.query('DELETE FROM repos WHERE id = $1', [id]);
  }
  await admin.end();
  await closePool();
});

describe('the CORTEX arm performs all four beats', () => {
  it('recalls, dedupes, blocks and closes — each as a real decision', async () => {
    const sessionId = await session();
    const result = await runScenario({ sessionId, arm: 'cortex', embed });

    const beat = (n: number) => result.steps.filter((s) => s.beat === n);

    // Beat 1 — a finding from the seeded past, ordered by its revert.
    const recalled = beat(1).find((s) => s.kind === 'recall');
    expect(recalled?.decision).toBe('recalled');
    const findings = (recalled?.detail['findings'] ?? []) as { timesReverted: number }[];
    expect(findings.length).toBeGreaterThan(0);
    // `07` §3 beat 1 promises "a note that a prior attempt was reverted". That note is
    // this number, and it arrives from the join in `recall`, not from a caption.
    expect(findings[0]?.timesReverted).toBeGreaterThan(0);

    // Beat 2 — deduped, and carrying the prior outcome rather than a rejection.
    const deduped = beat(2).find((s) => s.agent === SCRIPT.dedupeCaller.agent);
    expect(deduped?.decision).toBe('deduped');
    expect(deduped?.detail['of']).toBeTruthy();
    expect(result.meter.duplicateWorkAvoided).toBe(1);

    // Beat 3 — one winner, one blocked loser that learns who holds the file.
    expect(beat(3).find((s) => s.agent === SCRIPT.claimWinner.agent)?.decision).toBe('granted');
    const blocked = beat(3).find((s) => s.agent === SCRIPT.claimLoser.agent);
    expect(blocked?.decision).toBe('blocked');
    const contested = (blocked?.detail['contested'] ?? []) as { holder: string }[];
    // Invariant 3: the loser re-plans because it was told who to re-plan around.
    expect(contested[0]?.holder).toBe(SCRIPT.claimWinner.agent);
    expect(result.meter.blockedAndReplanned).toBe(1);

    // Beat 4 — the close happened. The finding is the changefeed's to deliver, and this
    // step deliberately does not claim one it has not seen.
    const closed = beat(4).find((s) => s.kind === 'close');
    expect(closed?.decision).toBe('done');
    expect(closed?.detail['intentId']).toBeTruthy();
  });

  it('labels the seeded past as seeded, never as something the fleet discovered', async () => {
    const sessionId = await session();
    const result = await runScenario({ sessionId, arm: 'cortex', embed });

    const seed = result.steps.find((s) => s.kind === 'seed');
    expect(seed).toBeDefined();
    expect(seed?.decision).toBe('seeded');
    expect(String(seed?.detail['note'])).toMatch(/stands in for/i);
  });
});

describe('the NAIVE arm runs the same script and loses', () => {
  it('recalls nothing, does the duplicate work, and loses a write', async () => {
    const sessionId = await session();
    const result = await runScenario({ sessionId, arm: 'naive', embed });

    expect(result.steps.find((s) => s.kind === 'recall')?.decision).toBe('nothing known');
    expect(result.meter.findingsRecalled).toBe(0);
    expect(result.meter.duplicateWorkDone).toBe(1);
    expect(result.meter.duplicateWorkAvoided).toBe(0);
    expect(result.meter.lostWrites).toBe(1);

    // Both agents proceeded on beat 2 — that is the duplicate work, stated as two steps
    // rather than as a counter that could have been written by hand.
    const proceeded = result.steps.filter((s) => s.beat === 2 && s.decision === 'proceeded');
    expect(proceeded.map((s) => s.agent)).toEqual([
      SCRIPT.dedupeHolder.agent,
      SCRIPT.dedupeCaller.agent,
    ]);
  });

  it('runs the same statements as CORTEX, so the contrast is the coordination layer', async () => {
    const cortex = await runScenario({ sessionId: await session(), arm: 'cortex', embed });
    const naive = await runScenario({ sessionId: await session(), arm: 'naive', embed });

    const scripted = (steps: typeof cortex.steps) =>
      steps.filter((s) => s.kind === 'propose').map((s) => s.statement).sort();

    // `07` §2: "Same scenario, same cassettes, visibly different outcome." If the arms
    // attempted different work, the difference in outcome would prove nothing.
    expect(scripted(naive.steps)).toEqual(scripted(cortex.steps));
  });
});

describe('the show-SQL panel gets a transcript of the run', () => {
  it('records the statements the run actually executed', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    await runScenario({ sessionId, arm: 'cortex', embed, recorder });

    const log = recorder.statements.map((s) => s.sql);
    expect(log.length).toBeGreaterThan(0);

    // The scope is set with a bound parameter on every transaction — the invariant-7
    // property from V26, visible in the panel rather than asserted in prose.
    const scoping = recorder.statements.filter((s) => s.sql.includes('set_config'));
    expect(scoping.length).toBeGreaterThan(0);
    expect(scoping.every((s) => s.parameters === 2)).toBe(true);

    // And the arbitration is there to be read: a dedupe search and a claim insert.
    expect(log.some((sql) => /FROM intents/.test(sql) && /<=>/.test(sql))).toBe(true);
    expect(log.some((sql) => /INSERT INTO claims/.test(sql))).toBe(true);
  });
});
