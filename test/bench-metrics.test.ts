/**
 * The offline judge and the metrics writer. spec/06-BENCHMARK-SPEC.md §3, §6, §7.
 *
 * These run against hand-built run records rather than the cluster, and that is not a
 * mock standing in for the data layer: there is no data layer here. U13 is arithmetic
 * over what U12 recorded, and the arithmetic is exactly where a wrong number becomes a
 * published one. `test/bench-runner.test.ts` is where the live half is proven.
 *
 * U13's named silent break is "a placeholder number reaching a results file". The first
 * describe block is that guard and nothing else.
 */
import { describe, expect, it } from 'vitest';

import { DuplicateJudge } from '../bench/judge.js';
import { computeMetrics, NOT_APPLICABLE, renderSummary, TBD } from '../bench/metrics.js';
import type { Acknowledged, RunRecord } from '../bench/types.js';

function ack(
  taskId: string,
  agent: string,
  result: 'done' | 'abandoned',
  window: [number, number],
  effects: Array<[string, number, number]> = [['src/a.ts', 1, 10]],
  tokens = { input: 100, output: 50 },
): Acknowledged {
  return {
    taskId,
    agent,
    result,
    effects: effects.map(([file, startLine, endLine]) => ({ file, startLine, endLine })),
    tokens,
    startVirtualMs: window[0],
    endVirtualMs: window[1],
  };
}

function record(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    arm: 'naive',
    seed: 1,
    agents: 2,
    taskIds: [],
    cassettes: { mode: 'replay', reasonKeys: [], embedKeys: [], liveCalls: { embed: 0, reason: 0 } },
    decisions: [],
    acknowledged: [],
    finalState: [],
    notes: [],
    timings: { steps: [], wallClockMs: 0, totalVirtualMs: 60_000, serializationRetries: 0 },
    ...partial,
  };
}

/** A record with something in it, so an unmeasured cell is unmeasured on purpose. */
function measurable(partial: Partial<RunRecord> = {}): RunRecord {
  return record({
    acknowledged: [ack('T1', 'a1', 'done', [0, 10])],
    finalState: ['T1'],
    ...partial,
  });
}

describe('no placeholder ever reaches a results file (§6, and 10 §62)', () => {
  it('renders an unmeasured metric as TBD, never as a number', () => {
    const base = computeMetrics(measurable({ arm: 'cortex' }), judgeStub());
    const summary = renderSummary([
      { arm: 'cortex', metrics: { ...base, claimP50Ms: TBD, serializationRetries: TBD } },
    ]);

    // Two cells are unmeasured, and both must say so in words. A zero here would be
    // indistinguishable from a measurement of zero, which is the whole failure.
    expect(summary.match(/TBD/g)).toHaveLength(2);
    expect(summary).not.toMatch(/claim_p50 \(ms\)\s*\|\s*0/);
  });

  it('says TBD when a rate has no denominator, rather than reporting zero', () => {
    // No completed work at all: the duplicate rate is 0/0. Rendering that as 0.00
    // would say "this arm duplicated nothing", which is a claim about a run that did
    // nothing at all.
    const metrics = computeMetrics(record({ arm: 'cortex' }), judgeStub());
    expect(metrics.duplicateWorkRate).toBe(TBD);
  });

  it('distinguishes "not measured" from "this arm has no such thing"', () => {
    const metrics = computeMetrics(measurable({ arm: 'naive' }), judgeStub());

    // The NAIVE arm has no arbitration transaction, so there is no latency to take a
    // percentile of. That is `n/a` — §6 renders it `—`. Calling it TBD would imply
    // someone still owes the reader a number, and nobody does.
    expect(metrics.claimP50Ms).toBe(NOT_APPLICABLE);
    expect(metrics.claimP95Ms).toBe(NOT_APPLICABLE);
    expect(metrics.serializationRetries).toBe(NOT_APPLICABLE);

    const summary = renderSummary([{ arm: 'naive', metrics }]);
    expect(summary).toMatch(/claim_p50 \(ms\)\s*\|\s*—/);
    expect(summary).not.toContain('TBD');
  });
});

describe('lost_writes (§3)', () => {
  it('is the acknowledged work absent from the final state', () => {
    const metrics = computeMetrics(
      record({
        acknowledged: [ack('T1', 'a1', 'done', [0, 10]), ack('T2', 'a2', 'done', [0, 10])],
        finalState: ['T1'],
      }),
      judgeStub(),
    );

    expect(metrics.lostWrites).toBe(1);
  });

  it('does not count an abandoned task as lost, because it was never claimed done', () => {
    const metrics = computeMetrics(
      record({
        acknowledged: [ack('T1', 'a1', 'done', [0, 10]), ack('T2', 'a2', 'abandoned', [0, 10])],
        finalState: ['T1'],
      }),
      judgeStub(),
    );

    expect(metrics.lostWrites).toBe(0);
  });
});

describe('conflicting_edits (§3)', () => {
  it('counts two agents overlapping in the same region and the same window', () => {
    const metrics = computeMetrics(
      record({
        acknowledged: [
          ack('T1', 'a1', 'done', [0, 100], [['src/a.ts', 10, 20]]),
          ack('T2', 'a2', 'done', [50, 150], [['src/a.ts', 15, 25]]),
        ],
        finalState: ['T1', 'T2'],
      }),
      judgeStub(),
    );

    expect(metrics.conflictingEdits).toBe(1);
  });

  it('does not count the same agent overlapping itself, nor disjoint windows', () => {
    const sameAgent = computeMetrics(
      record({
        acknowledged: [
          ack('T1', 'a1', 'done', [0, 100], [['src/a.ts', 10, 20]]),
          ack('T2', 'a1', 'done', [50, 150], [['src/a.ts', 15, 25]]),
        ],
      }),
      judgeStub(),
    );
    const apart = computeMetrics(
      record({
        acknowledged: [
          ack('T1', 'a1', 'done', [0, 40], [['src/a.ts', 10, 20]]),
          ack('T2', 'a2', 'done', [50, 150], [['src/a.ts', 15, 25]]),
        ],
      }),
      judgeStub(),
    );

    expect(sameAgent.conflictingEdits).toBe(0);
    expect(apart.conflictingEdits).toBe(0);
  });

  it('does not count different regions of the same file', () => {
    const metrics = computeMetrics(
      record({
        acknowledged: [
          ack('T1', 'a1', 'done', [0, 100], [['src/a.ts', 1, 9]]),
          ack('T2', 'a2', 'done', [0, 100], [['src/a.ts', 10, 20]]),
        ],
      }),
      judgeStub(),
    );

    expect(metrics.conflictingEdits).toBe(0);
  });
});

describe('the offline duplicate judge (§3)', () => {
  const judge = DuplicateJudge.fromCassettes();

  it('shares no code with the dedupe path', async () => {
    // §3: "`duplicate_work_rate` MUST be computed by an offline judge that does not
    // share code with the dedupe path. Measuring a mechanism with itself is the most
    // common way benchmarks like this become worthless, and a database-company judge
    // will look for it." This is that assertion, made mechanically: the judge's module
    // may not reach `src/`, so it cannot import the threshold, the SQL, or the
    // embedder that the mechanism under test uses.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../bench/judge.ts', import.meta.url), 'utf8'),
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

    expect(imports.filter((path) => path.includes('/src/') || path.includes('../src'))).toEqual([]);
    expect(imports.filter((path) => path.includes('propose'))).toEqual([]);
  });

  it('knows a vector for every task in the list', () => {
    expect(judge.missing()).toEqual([]);
  });

  it('ranks a declared pair closer than any pair that is not declared', () => {
    // V11 measured this on the corpus and it is the property the whole benchmark
    // rests on: if a declared pair does not separate, `duplicate_work_rate` measures
    // nothing. Asserted here against the judge's own distance function, which is not
    // the one the mechanism uses.
    const { worstDeclared, bestUndeclared } = judge.separation();
    expect(worstDeclared).toBeLessThan(bestUndeclared);
  });

  it('reports a sweep whose recall is monotonic in the threshold', () => {
    const sweep = judge.sweep([0.1, 0.2, 0.3, 0.4, 0.5]);
    const recalls = sweep.map((row) => row.recall);

    expect(recalls).toEqual([...recalls].sort((a, b) => a - b));
    expect(sweep.at(-1)!.recall).toBeGreaterThan(sweep[0]!.recall);
  });
});

/** A judge that calls nothing a duplicate, for the metrics that do not involve it. */
function judgeStub(): { duplicatesAmong: (ids: readonly string[]) => Set<string> } {
  return { duplicatesAmong: () => new Set<string>() };
}
