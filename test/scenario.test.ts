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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder, byTransaction, claimLatenciesMs } from '../src/db/recorder.js';
import { SCRIPT, runScenario } from '../src/demo/scenario.js';
import { createDemoSession } from '../src/memory/demo.js';
import {
  loadSharedState,
  saveSharedState,
  type SharedWorkState,
} from '../src/memory/shared-state.js';

import { paraphraseOf, vector } from './helpers/vectors.js';

const sessions: string[] = [];

async function session(): Promise<string> {
  const created = await createDemoSession();
  sessions.push(created.sessionId);
  return created.sessionId;
}

/**
 * The NAIVE arm's shared cell, read as an administrator rather than through the demo plane.
 *
 * Deliberately not `loadSharedState`: this is the independent check on what that function
 * reported, so it must not run the code it is checking. A bug that made the loader return
 * a stale or empty snapshot would otherwise agree with itself.
 */
async function sharedState(sessionId: string): Promise<SharedWorkState | null> {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ demo_shared_state: SharedWorkState | null }>(
      'SELECT demo_shared_state FROM repos WHERE id = $1',
      [sessionId],
    );
    return rows[0]?.demo_shared_state ?? null;
  } finally {
    await admin.end();
  }
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

/**
 * NO METER FIELD IS WRITTEN BY THE SCRIPT — `07` §1: "every number on screen is real and
 * comes from the database".
 *
 * This is a source-text check rather than a behavioural one, and deliberately so. The
 * defect it exists to prevent is not a wrong number, it is a *fabricated* one, and a
 * fabricated number is indistinguishable from a measured one at the point of assertion:
 *
 *     meter.duplicateWorkDone += 1;   // unconditional
 *     meter.lostWrites += 1;          // unconditional
 *
 * Both of those were in this file, in the NAIVE branch, rendered in the same table and in
 * the same style as figures the driver had timed. Every behavioural test passed, because
 * what they asserted was the constant. So the assertion has to be about the shape of the
 * code: a meter field may be assigned from an expression over observed values, and may be
 * incremented only under a condition that inspects one.
 */
describe('every meter figure is measured, not asserted — `07` §1', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/demo/scenario.ts', import.meta.url)),
    'utf8',
  );

  /**
   * Comments are stripped before the scan, and the first version of this test was wrong
   * not to be: the file's own header quotes the two fabricated lines while explaining why
   * they are gone, and the check flagged the explanation. A rule that fires on the
   * description of the defect it prevents is a rule that gets deleted.
   *
   * Block comments go first (that is where the quotations live), then whole-line `//`
   * comments. A trailing `//` is not stripped, so a fabrication smuggled into one would
   * still be caught — and a `//` inside a string literal cannot hide a mutation, because
   * the mutation would have to be inside the string too.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /**
   * Named explicitly rather than discovered, so the check cannot be sidestepped by moving
   * the numbers into a differently-shaped variable. The first version of this test only
   * looked for `meter.field …`, and rewriting the file to assemble the meter at the end
   * made every rule pass with nothing to check — a guard that a refactor can walk out of.
   * Adding a field here is the one manual step, and `meter figures are all covered` below
   * fails if a field is added to the result and not to this list.
   */
  const METER_FIELDS = [
    'duplicateWorkAvoided',
    'duplicateWorkDone',
    'lostWrites',
    'blockedAndReplanned',
    'findingsRecalled',
    'claimP50Ms',
    'serializationRetries',
  ];

  const anyField = METER_FIELDS.join('|');

  it('still has the code it is checking after comments are stripped', () => {
    // Guards the stripping itself: a regex that ate the file would make every check below
    // pass vacuously, which is the failure mode of every source-text assertion.
    expect(code).toContain('export async function runScenario');
    expect(code).toContain('duplicatesAmong');
    for (const field of METER_FIELDS) expect(code).toContain(field);
  });

  it('covers every field the meter actually reports', async () => {
    const sessionId = await session();
    const result = await runScenario({ sessionId, arm: 'cortex', embed });
    expect(Object.keys(result.meter).sort()).toEqual([...METER_FIELDS].sort());
  });

  /**
   * An increment is the shape the fabrication took, so it carries the strictest rule: the
   * statement must be guarded, on its own line, by a condition.
   * `if (caller.decision === 'deduped') duplicateWorkAvoided += 1` is a count of something
   * that happened; `duplicateWorkDone += 1` is a claim about something that would have.
   */
  it('increments a meter figure only under a condition', () => {
    const unguarded = [...code.matchAll(new RegExp(`^.*\\b(?:${anyField})\\s*\\+=.*$`, 'gm'))]
      .map(([line]) => line!.trim())
      .filter((line) => !/\bif\s*\(/.test(line));

    expect(unguarded).toEqual([]);
  });

  /**
   * And no meter figure is ever set to a number that was typed rather than counted.
   *
   * The one exception is a `let`/`const` initialiser at zero, which is how an accumulator
   * starts before anything has happened to it. Every other numeric literal — in an
   * assignment, in the returned object, at zero or otherwise — is the defect: a `0` written
   * into the CORTEX column is exactly as fabricated as the `1`s that were written into the
   * NAIVE one, and `06` §6 is explicit that "measured as nought" and "no such thing to
   * measure" are different answers that must not be spelled the same way.
   */
  it('never sets a meter figure from a numeric literal', () => {
    const typed = [
      ...code.matchAll(new RegExp(`^.*\\b(?:${anyField})\\s*(?:=|:)\\s*-?\\d[\\d._]*.*$`, 'gm')),
    ]
      .map(([line]) => line!.trim())
      .filter((line) => !/^(let|const)\b.*=\s*0[,;]?$/.test(line));

    expect(typed).toEqual([]);
  });
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
    //
    // **Which** agent wins is not asserted, and must not be.  The two proposals are in
    // flight at the same time and CockroachDB's unique index on `(repo_id, resource_key)`
    // decides between them, so a test naming the winner would be asserting a race it does
    // not control — it would pass on the runs that happened to order themselves the old way
    // and fail on the rest. What is asserted is the shape the beat promises: exactly one of
    // the two proceeds, and the other names it.
    const contenders = beat(3).filter((s) => s.kind === 'propose');
    expect(contenders).toHaveLength(2);

    const granted = contenders.filter((s) => s.decision === 'granted');
    const blockedSteps = contenders.filter((s) => s.decision === 'blocked');

    // Never two winners. This is the arbitration itself and it holds on every run, however
    // the race falls out.
    expect(granted.length).toBeLessThanOrEqual(1);

    // And on this run, one of them won and the other was told so. There is a rare third
    // outcome — both agents exhausting two rounds of five SERIALIZABLE attempts, which
    // `replanOnce` reports as `contended` rather than failing — measured at roughly one run
    // in twelve before the re-plan was added and so around one in a hundred and fifty
    // after. If these two lines start flaking, that is the alarm saying the rate has moved,
    // and the answer is `src/db/retry.ts`'s backoff, not a weaker assertion here.
    expect(granted).toHaveLength(1);
    expect(blockedSteps).toHaveLength(1);

    const contested = (blockedSteps[0]?.detail['contested'] ?? []) as { holder: string }[];
    // Invariant 3: the loser re-plans because it was told who to re-plan around — and the
    // agent it was told about is *the other one*, whichever that turned out to be.
    expect(contested[0]?.holder).toBe(granted[0]?.agent);
    expect([SCRIPT.contenderA.agent, SCRIPT.contenderB.agent]).toContain(granted[0]?.agent);
    expect(result.meter.blockedAndReplanned).toBe(1);

    // The granted agent is reported first, so the fleet panel reads winner-then-loser
    // regardless of which of the two the cluster picked.
    expect(contenders[0]?.decision).toBe('granted');

    // `04` §7 requires claim p50 and the retry counter on screen, live. Both are measured
    // from this run: the p50 comes from the recorder's timings on the claims insert, and a
    // run that claimed nothing reports null rather than a flattering zero.
    expect(result.meter.serializationRetries).toBeGreaterThanOrEqual(0);

    // `duplicate work done` and `writes lost` are measured for this arm too — not left
    // blank, and not written down as zeroes. The agent that would have duplicated was
    // deduped, so it did no work and the after-the-fact rule has nothing to find; every
    // agent that was granted still has its intent, because nobody else could take its
    // claim. Both figures come back through the same code paths the NAIVE arm uses.
    expect(result.meter.duplicateWorkDone).toBe(0);
    expect(result.meter.lostWrites).toBe(0);

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
  it('recalls nothing, does the duplicate work, and loses writes it acknowledged', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    const result = await runScenario({ sessionId, arm: 'naive', embed, recorder });

    expect(result.steps.find((s) => s.kind === 'recall')?.decision).toBe('nothing known');
    expect(result.meter.findingsRecalled).toBe(0);
    expect(result.meter.duplicateWorkAvoided).toBe(0);

    // The two beat-2 statements are paraphrases, so the after-the-fact rule finds one
    // duplicate among work that was actually done. In the CORTEX arm the same rule over
    // the same threshold finds none, because one of those two agents never did the work.
    expect(result.meter.duplicateWorkDone).toBe(1);

    // All four proceeded — that is the duplicate work and the contention, stated as steps
    // rather than as counters that could have been written by hand.
    const proceeded = result.steps.filter((s) => s.kind === 'propose');
    expect(proceeded.map((s) => s.agent)).toEqual([
      SCRIPT.dedupeHolder.agent,
      SCRIPT.dedupeCaller.agent,
      SCRIPT.contenderA.agent,
      SCRIPT.contenderB.agent,
    ]);
    expect(proceeded.every((s) => s.decision === 'proceeded')).toBe(true);

    /**
     * `lostWrites` is a subtraction over two observed quantities, and this is the
     * independent check on it: read the shared cell as an administrator, outside the demo
     * plane entirely, and count what actually survived.
     *
     * The **value** is not asserted. It is decided by four real UPDATEs racing, so it moves
     * between runs — and a test that pinned it would be asserting the outcome of a race,
     * which is the defect this whole change exists to remove, pointed the other way. That
     * the loss happens at all is proven deterministically further down, at the mechanism.
     */
    const stored = await sharedState(sessionId);
    const survived = Object.keys(stored?.completed ?? {}).length;
    const saved = result.steps.filter(
      (s) => s.kind === 'close' && (s.decision === 'saved' || s.decision === 'overwritten'),
    ).length;

    expect(saved).toBe(4);
    expect(result.meter.lostWrites).toBe(saved - survived);
    expect(result.meter.lostWrites).toBeGreaterThanOrEqual(0);
    expect(result.meter.lostWrites).toBeLessThan(saved);

    // Exactly the agents whose entries are gone are the ones reported as overwritten.
    const overwritten = result.steps
      .filter((s) => s.kind === 'close' && s.decision === 'overwritten')
      .map((s) => s.agent)
      .sort();
    const missing = proceeded
      .map((s) => s.agent)
      .filter((agent) => stored?.completed[agent] === undefined)
      .sort();
    expect(overwritten).toEqual(missing);
  });

  /**
   * The show-SQL panel's NAIVE column used to read "0 statements", which was true and was
   * the whole problem: an arm that executes nothing cannot lose a write, so the two
   * figures beside it were the script asserting what would have happened. This is the
   * assertion that the arm now does the work.
   */
  it('executes real statements against the real cluster', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    await runScenario({ sessionId, arm: 'naive', embed, recorder });

    const log = recorder.statements.map((s) => s.sql);
    expect(log.some((sql) => /SELECT demo_shared_state/.test(sql))).toBe(true);
    expect(log.some((sql) => /UPDATE repos SET demo_shared_state/.test(sql))).toBe(true);

    // And it holds no claim and inserts no intent — the contrast is that it coordinates
    // through nothing, not that it runs a different script.
    expect(log.some((sql) => /INSERT INTO claims/.test(sql))).toBe(false);
    expect(log.some((sql) => /INSERT INTO intents/.test(sql))).toBe(false);
  });

  /**
   * The only test in this file that runs **two** full scenarios, and so the only one the
   * suite-wide 30s budget does not fit.
   *
   * Measured on an idle machine, 2026-08-13: **22,466 ms of 30,000** — 2.1x the next
   * slowest test here, with 7.5s of headroom. Under `npm test` it shares one Basic-tier
   * cluster with 25 other files and it timed out, then passed on its own. That is not a
   * flake to re-run; it is a test whose real cost sits at three quarters of its budget and
   * whose margin shrinks every time the suite grows.
   *
   * The budget is raised here and nowhere else. `vitest.config.mts` stays at 30s, because
   * that global is what keeps a genuinely hung test from hanging the suite, and every other
   * test in this file fits inside it comfortably. Nothing about the assertion changes: two
   * real runs against the real cluster, compared on the work they attempted.
   */
  it(
    'runs the same statements as CORTEX, so the contrast is the coordination layer',
    async () => {
      const cortex = await runScenario({ sessionId: await session(), arm: 'cortex', embed });
      const naive = await runScenario({ sessionId: await session(), arm: 'naive', embed });

      const scripted = (steps: typeof cortex.steps) =>
        steps.filter((s) => s.kind === 'propose').map((s) => s.statement).sort();

      // `07` §2: "Same scenario, same cassettes, visibly different outcome." If the arms
      // attempted different work, the difference in outcome would prove nothing.
      expect(scripted(naive.steps)).toEqual(scripted(cortex.steps));
    },
    90_000,
  );

  /**
   * THE LOSS ITSELF, PROVEN WITHOUT A RACE.
   *
   * The scenario's own losses come out of four concurrent agents, so how many there are
   * changes between runs and no test may pin the number. This one pins the *mechanism*
   * instead, by interleaving two agents by hand: both read the same snapshot, then both
   * write it back, and the first one's entry is gone. Nothing here drops it — the second
   * save simply carries a snapshot that predates the first, which is what last-write-wins
   * on a whole-artifact rewrite means and what `06` §2 specifies for this arm.
   *
   * If this ever passes with both entries present, the naive arm has acquired a merge and
   * is no longer the thing the demo claims it is.
   */
  it('loses a write when two agents write back a snapshot taken before the other landed', async () => {
    const sessionId = await session();
    const scope = { plane: 'demo', demoSession: sessionId } as const;

    const first = await loadSharedState(sessionId, scope);
    const second = await loadSharedState(sessionId, scope);

    first.completed['agent-a'] = {
      agent: 'agent-a',
      statement: 'first',
      resourceKeys: ['file:a.ts'],
      note: 'first',
    };
    await saveSharedState(sessionId, first, scope);

    second.completed['agent-b'] = {
      agent: 'agent-b',
      statement: 'second',
      resourceKeys: ['file:b.ts'],
      note: 'second',
    };
    await saveSharedState(sessionId, second, scope);

    const stored = await sharedState(sessionId);
    expect(Object.keys(stored?.completed ?? {})).toEqual(['agent-b']);
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

  it('measures claim p50 from the claims this run actually inserted', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    const result = await runScenario({ sessionId, arm: 'cortex', embed, recorder });

    const claimTimings = claimLatenciesMs(recorder.statements);
    expect(claimTimings.length).toBeGreaterThan(0);
    expect(result.meter.claimP50Ms).not.toBeNull();
    // Within the range of what was actually timed, rather than merely non-zero.
    expect(result.meter.claimP50Ms!).toBeGreaterThanOrEqual(Math.min(...claimTimings));
    expect(result.meter.claimP50Ms!).toBeLessThanOrEqual(Math.max(...claimTimings));
  });

  /**
   * A NAIVE fleet acquires no claims, so there is no claim to time. Null is the honest
   * answer and a zero would read as "instant" on the meter — `06` §6's distinction between
   * "no such thing to measure" and "measured as nought", applied to the panel.
   *
   * It **does** now execute statements, which is the point of this whole change. So the
   * assertion is that it acquired no claim, not that it did nothing.
   */
  it('reports no claim p50 for an arm that claims nothing', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    const result = await runScenario({ sessionId, arm: 'naive', embed, recorder });

    expect(recorder.statements.length).toBeGreaterThan(0);
    expect(claimLatenciesMs(recorder.statements)).toHaveLength(0);
    expect(result.meter.claimP50Ms).toBeNull();
  });

  /**
   * ONE TRANSACTION PER BLOCK, EVEN WHEN AGENTS OVERLAP.
   *
   * Invariant 1 is readable off this panel only because the dedupe search and the claim
   * insert sit between one BEGIN and one COMMIT. Beat 3's agents now run at the same time,
   * so a flat list interleaves their statements and that reading is lost. Grouping by
   * `txn` restores it — and this test is what stops the grouping regressing into
   * decoration, by requiring the arbitration to be co-located *within a single group*.
   */
  it('groups the transcript so each transaction can be read on its own', async () => {
    const sessionId = await session();
    const recorder = new StatementRecorder();
    await runScenario({ sessionId, arm: 'cortex', embed, recorder });

    const transactions = byTransaction(recorder.statements);
    expect(transactions.length).toBeGreaterThan(1);

    // Every group is exactly one transaction: it opens with a BEGIN and nothing inside it
    // opens a second.
    for (const transaction of transactions) {
      const begins = transaction.statements.filter((s) => s.sql.startsWith('BEGIN'));
      expect(begins).toHaveLength(1);
      expect(transaction.statements[0]?.sql.startsWith('BEGIN')).toBe(true);
    }

    // And the arbitration is co-located inside a single one of them, which is the thing a
    // sceptical judge is being invited to check.
    const arbitration = transactions.find((t) =>
      t.statements.some((s) => /INSERT INTO claims/.test(s.sql)),
    );
    expect(arbitration).toBeDefined();
    expect(
      arbitration!.statements.some((s) => /FROM intents/.test(s.sql) && /<=>/.test(s.sql)),
    ).toBe(true);
  });
});
