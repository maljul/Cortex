/**
 * THE WORKLOAD RUNNER'S GUARDS — the three things about it that can break without anything
 * looking wrong.
 *
 * Design §6: "`test/scenario.test.ts` fails if a meter field is set from a numeric literal or
 * incremented without a condition. The equivalent test must exist for the new runner **before**
 * the runner does." It did not — this file is written after `src/demo/workload.ts` and the
 * verification log says so rather than implying otherwise. What it asserts is stricter than the
 * rule it inherits, because the runner has no increments to guard: every figure is a count over
 * `steps` and `events`, a subtraction over a readback of the tree, or a distance the cluster
 * computed.
 *
 * The other two guards are the failures the **first live run** found, both of which passed every
 * test that existed at the time and both of which silently deleted an interlock:
 *
 * - a dedupe pair whose halves are in different waves is deduplicated by the *naive* lane too,
 *   because a two-transaction dedupe against an intent that committed a second ago works fine;
 * - a task that informs another must close before that other one asks, or recall has nothing to
 *   return and the interlock quietly does not happen.
 *
 * Both are properties of `ASSIGNMENT`, so both are now assertions about it.
 *
 * The end-to-end proof is `npm run gate:workload`, not this file: eleven tickets across two arms
 * takes about a minute of real cluster time, and `06`-scale runs belong in a gate a human reads.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEMO_TASKS, taskById } from '../bench/demo-workload.js';
import { AGENTS, ASSIGNMENT, authorshipOf, type Authoring } from '../src/demo/workload.js';

const source = readFileSync(
  fileURLToPath(new URL('../src/demo/workload.ts', import.meta.url)),
  'utf8',
);

/**
 * Comments are stripped before the scan, and `test/scenario.test.ts` learned the hard way why:
 * that file's header quotes the two fabricated lines while explaining that they are gone, and
 * the first version of the check flagged the explanation. A rule that fires on the description
 * of the defect it prevents is a rule that gets deleted.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Named explicitly rather than discovered, so the check cannot be sidestepped by moving the
 * numbers into a differently-shaped variable — which is exactly how the first version of the
 * scenario's guard was walked out of. Adding a field to `ArmMeter` and not to this list fails
 * the coverage assertion below.
 */
const METER_FIELDS = [
  'duplicateWorkAvoided',
  'duplicateWorkDone',
  'lostWrites',
  'blockedAndReplanned',
  'findingsRecalled',
  'agentsSpared',
  'deadEndsWalked',
  'conflictingEdits',
  'fileCollisions',
  'embeddingCalls',
  'claimP50Ms',
  'serializationRetries',
  'wastedTokens',
  'hunksAuthoredByModel',
  'hunksReplayed',
  'hunksFallenBack',
  'modelInputTokens',
  'modelOutputTokens',
];

/**
 * The body of an object literal that starts at `opener`, brace-counted.
 *
 * A regex cannot do this — the meter literal contains nested calls with their own braces — and
 * the assertion it feeds is the one that says every declared field is actually returned, so it
 * has to be exact rather than approximately right.
 */
function literalAfter(source: string, opener: string): string {
  const start = source.indexOf(opener);
  expect(start, `${opener} is not in the source`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let at = start + opener.length - 1; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1;
    else if (source[at] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, at + 1);
    }
  }

  throw new Error(`${opener} is never closed`);
}

describe('every meter figure is measured, not asserted — `07` §1', () => {
  it('still has the code it is checking after comments are stripped', () => {
    // Guards the stripping itself: a regex that ate the file would make every check below pass
    // vacuously, which is the failure mode of every source-text assertion.
    expect(code).toContain('export async function runArm');
    expect(code).toContain('duplicatesAmong');
    for (const field of METER_FIELDS) expect(code).toContain(field);
  });

  /**
   * **THE LIST ABOVE CLAIMED THIS AND NOTHING CHECKED IT, UNTIL U23.**
   *
   * `METER_FIELDS`' own comment said "adding a field to `ArmMeter` and not to this list fails the
   * coverage assertion below". It did not: the assertion above checks every *listed* field appears
   * in the source, which is the opposite direction. A new meter figure could be added, rendered,
   * and set from a literal, and every check in this file would have gone on passing — which is
   * exactly U23's done-when ("every rendered number has a test that fails if it is set from a
   * literal") failing silently on the numbers most likely to be fabricated: the new ones.
   *
   * Found while adding two. The field list is now read out of `ArmMeter` itself, so the direction
   * the comment always claimed is the direction that is enforced.
   */
  it('checks every field `ArmMeter` actually declares', () => {
    const block = /export interface ArmMeter \{([\s\S]*?)\n\}/.exec(code);
    expect(block).not.toBeNull();

    const declared = [...block![1]!.matchAll(/^\s*(\w+)\s*[?]?:/gm)].map(([, name]) => name!);

    // Non-vacuity: a regex that matched nothing would make the comparison trivially true.
    expect(declared.length).toBeGreaterThan(5);
    expect(new Set(declared)).toEqual(new Set(METER_FIELDS));
  });

  /**
   * THE OTHER HALF OF THAT, AND THE REASON FIVE OF THE FIELDS ARE OPTIONAL.
   *
   * `ArmMeter`'s authorship figures are declared with a `?` so that an `ArmResult` built by hand
   * elsewhere in the suite does not have to be rewritten to name them. That is a convenience with
   * a hole in it: an optional field the runner forgets to set renders as `undefined` on the page,
   * and nothing above would notice, because the declaration test only asks that the *names* match.
   *
   * So the returned literal is read and every declared field has to be a key in it. The runner
   * may not declare a figure it does not return.
   */
  it('returns every field it declares, so an optional one cannot go unset', () => {
    const returned = literalAfter(code, 'meter: {');

    for (const field of METER_FIELDS) {
      expect(returned, `runArm declares ${field} and never sets it`).toMatch(
        new RegExp(`\\b${field}:`),
      );
    }
    // Non-vacuity: a truncated literal would satisfy nothing, and an over-long one everything.
    expect(returned.length).toBeGreaterThan(200);
    expect(returned).not.toContain('export ');
  });

  it('never sets a meter figure from a numeric literal', () => {
    const typed = [
      ...code.matchAll(new RegExp(`^.*\\b(?:${METER_FIELDS.join('|')})\\s*(?:=|:)\\s*-?\\d[\\d._]*.*$`, 'gm')),
    ].map(([line]) => line!.trim());

    expect(typed).toEqual([]);
  });

  it('never increments a meter figure at all', () => {
    // Stricter than the rule this inherits. `test/scenario.test.ts` permits an increment that is
    // guarded on its own line by a condition; here there is no legitimate increment to permit,
    // because every figure is derived at the end from what was recorded. So the shape the
    // fabrication took in U16b cannot occur in any form, guarded or not.
    const incremented = [
      ...code.matchAll(new RegExp(`^.*\\b(?:${METER_FIELDS.join('|')})\\s*(?:\\+\\+|\\+=).*$`, 'gm')),
    ].map(([line]) => line!.trim());

    expect(incremented).toEqual([]);
  });

  it('has exactly one unconditional counter, and it counts its own invocation', () => {
    // The allowlist is one line long and it is named here rather than excused by a pattern.
    // `tally.calls += 1` sits at the top of the embedder wrapper, so the condition for the
    // increment is that the call happened — the increment *is* the observation. Any second
    // unconditional counter has to be argued for here, in public, which is the point.
    const counters = [...code.matchAll(/^.*\btally\.\w+\s*\+=.*$/gm)].map(([line]) => line!.trim());

    expect(counters).toEqual(['tally.calls += 1;', 'if (result.degraded) tally.degraded += 1;']);
  });

  /**
   * `06` §3 sums `wasted_tokens` from `intents.tokens_spent`, and `close()` has written that
   * column since the beginning — the runner simply never had a number to give it. It does now, so
   * every close has to carry one. A close added later without it would leave a row reading zero
   * beside an agent that spent a thousand tokens, and nothing else in the system could tell.
   */
  it('tells the cluster what every closed intent cost', () => {
    const closes: string[] = [];
    for (let at = code.indexOf('close({'); at !== -1; at = code.indexOf('close({', at + 1)) {
      closes.push(literalAfter(code.slice(at), '({'));
    }

    // Non-vacuity: this runner closes on four paths — done and abandoned in each lane.
    expect(closes.length).toBeGreaterThanOrEqual(4);
    for (const one of closes) expect(one).toContain('tokensSpent: tokensSpentOn(');
  });

  it('derives every authorship figure rather than declaring one', () => {
    // The five authorship figures and `wastedTokens` are all set from one call, so there is one
    // place to read and it is a function this file can run. A figure assigned from anything else
    // would have to be argued for here.
    const returned = literalAfter(code, 'meter: {');
    for (const field of ['hunksAuthoredByModel', 'hunksReplayed', 'hunksFallenBack',
      'modelInputTokens', 'modelOutputTokens', 'wastedTokens']) {
      expect(returned).toMatch(new RegExp(`\\b${field}: authorship\\.`));
    }
  });
});

/**
 * THE AUTHORSHIP FIGURES, RUN RATHER THAN READ.
 *
 * `authorshipOf` is pure and exported so that the two rules that matter can be proved without a
 * cluster: the three hunk counts partition the work, and **a token count nobody measured is
 * `null` rather than `0`**. The second is the one most likely to be crossed by accident — on
 * REPLAY every record honestly reports zero tokens, and summing zeroes produces a `0` that
 * renders exactly like a measurement of nothing spent, which `06` §6 forbids.
 */
describe('authorship is a filter and a sum over what happened', () => {
  const record = (over: Partial<Authoring>): Authoring => ({
    taskId: 'C1',
    agent: 'agent-1',
    source: 'committed',
    hunks: 1,
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  });

  it('says TBD, not nought, when no model was called', () => {
    const replay = [record({}), record({ taskId: 'C2', hunks: 2 })];
    const figures = authorshipOf(replay, ['C2']);

    expect(figures.hunksReplayed).toBe(3);
    expect(figures.hunksAuthoredByModel).toBe(0);
    expect(figures.hunksFallenBack).toBe(0);
    // The whole point: C2 is in the wasted set and the answer is still TBD, because nobody spent
    // a token on it and nobody measured one.
    expect(figures.wastedTokens).toBeNull();
    expect(figures.modelInputTokens).toBeNull();
    expect(figures.modelOutputTokens).toBeNull();
  });

  it('says nought, not TBD, once a call has been made and nothing was wasted', () => {
    const live = [record({ source: 'model', inputTokens: 900, outputTokens: 120 })];
    const figures = authorshipOf(live, []);

    expect(figures.modelInputTokens).toBe(900);
    expect(figures.modelOutputTokens).toBe(120);
    // Measured, and it measured nothing wasted. That is a different fact from "nobody measured".
    expect(figures.wastedTokens).toBe(0);
  });

  it('partitions every hunk between the model, the fallback and the replay', () => {
    const mixed = [
      record({ taskId: 'I3', source: 'model', hunks: 2, inputTokens: 800, outputTokens: 200 }),
      record({ taskId: 'C1', source: 'fallback', hunks: 3, inputTokens: 700, outputTokens: 40 }),
      record({ taskId: 'C2', source: 'committed', hunks: 4 }),
    ];
    const figures = authorshipOf(mixed, []);

    expect(figures.hunksAuthoredByModel).toBe(2);
    expect(figures.hunksFallenBack).toBe(3);
    expect(figures.hunksReplayed).toBe(4);
    expect(
      figures.hunksAuthoredByModel + figures.hunksFallenBack + figures.hunksReplayed,
    ).toBe(mixed.reduce((total, one) => total + one.hunks, 0));

    // A rejected answer was still billed, so the fallback's tokens are in the spend.
    expect(figures.modelInputTokens).toBe(1500);
    expect(figures.modelOutputTokens).toBe(240);
  });

  it('counts as wasted only the tokens spent on work that ended abandoned or duplicated', () => {
    // `06` §3's own rule, and the reason the caller supplies the set: only the run knows which
    // tickets those were. A ticket that delivered is not waste however much it cost.
    const spend = [
      record({ taskId: 'A1', source: 'model', inputTokens: 500, outputTokens: 50 }),
      record({ taskId: 'P2b', source: 'model', inputTokens: 300, outputTokens: 30 }),
      record({ taskId: 'I3', source: 'model', inputTokens: 900, outputTokens: 90 }),
    ];

    expect(authorshipOf(spend, ['A1', 'P2b']).wastedTokens).toBe(880);
    expect(authorshipOf(spend, []).wastedTokens).toBe(0);
    expect(authorshipOf(spend, ['A1', 'P2b', 'I3']).wastedTokens).toBe(1870);
  });
});

describe('the assignment is what makes the interlocks possible', () => {
  it('covers every ticket exactly once, across five agents', () => {
    const assigned = ASSIGNMENT.map((a) => a.taskId);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(new Set(assigned)).toEqual(new Set(DEMO_TASKS.map((t) => t.id)));
    expect(new Set(ASSIGNMENT.map((a) => a.agent))).toEqual(new Set(AGENTS));
  });

  it('gives no agent two tickets in the same wave', () => {
    // An agent is one worker. Two tickets in one wave would mean the fleet is five agents on
    // paper and ten in the run, and the concurrency arithmetic design §5.2 is built on — two
    // Lambda invocations, ten agents as async tasks — would be describing something else.
    const seen = new Set<string>();
    for (const { wave, agent } of ASSIGNMENT) {
      const key = `${wave}:${agent}`;
      expect(seen.has(key), `${agent} has two tickets in wave ${wave}`).toBe(false);
      seen.add(key);
    }
  });

  it('races both halves of every dedupe pair in one wave', () => {
    // THE FIRST LIVE RUN'S FINDING. Sequenced, the naive lane deduplicates them too — P6b at
    // 0.0610 and P2b at 0.2058 — because its dedupe search against an intent that committed a
    // second ago works perfectly well. Design §4.2 puts the failure under concurrency: "the
    // dedupe passes against a snapshot that was true a moment ago". Split these across waves
    // again and interlock 4 disappears with every test still green.
    const waveOf = new Map(ASSIGNMENT.map((a) => [a.taskId, a.wave]));
    const pairs: [string, string][] = [
      ['P6a', 'P6b'],
      ['P2a', 'P2b'],
    ];
    for (const [a, b] of pairs) {
      expect(waveOf.get(a), `${a} and ${b} must race`).toBe(waveOf.get(b));
    }
  });

  it('closes an informing task in an earlier wave than the task it informs', () => {
    // The other half of the same lesson. Recall can only return what consolidation has written,
    // and consolidation only happens once the informing intent has closed. Same wave means the
    // informed agent asks too early, gets nothing, honestly reports "nothing known", and the
    // interlock does not happen — with nothing failing anywhere.
    const waveOf = new Map(ASSIGNMENT.map((a) => [a.taskId, a.wave]));

    for (const task of DEMO_TASKS) {
      const informer = task.informedBy ?? task.sparedBy;
      if (!informer) continue;

      expect(
        waveOf.get(informer)!,
        `${informer} must close before ${task.id} asks what is known`,
      ).toBeLessThan(waveOf.get(task.id)!);
    }
  });

  it('assigns the spared ticket to an agent that is not the one that gave up', () => {
    // Interlock 5 is one agent being spared by *another* agent's abandonment. The same agent
    // remembering its own dead end is a much weaker claim and would read as one.
    const t11 = ASSIGNMENT.find((a) => a.taskId === 'T11')!;
    const a1 = ASSIGNMENT.find((a) => a.taskId === 'A1')!;

    expect(t11.agent).not.toBe(a1.agent);
    expect(taskById('T11').sparedBy).toBe('A1');
  });
});
