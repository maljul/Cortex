/**
 * The metrics in spec/06-BENCHMARK-SPEC.md §3, and the table in §6.
 *
 * Three vocabulary rules, because U13's named silent break is "a placeholder number
 * reaching a results file" and the way that happens is a cell that *looks* measured:
 *
 * - a **number** is a measurement, computed from a run record;
 * - **`TBD`** means nobody has measured it yet — `10` §62 forbids inventing one;
 * - **`n/a`** (rendered as §6's `—`) means the arm has no such thing to measure, which
 *   is different from not having measured it. The NAIVE arm has no arbitration
 *   transaction, so `claim_p50` is not a gap in the data.
 *
 * Conflating the last two is the subtle version of the failure: a reader who sees `—`
 * where `TBD` belongs concludes the metric does not apply, and stops asking.
 */
import type { DuplicateJudge } from './judge.js';
import type { Arm, RunRecord } from './types.js';

export const TBD = 'TBD' as const;
export const NOT_APPLICABLE = 'n/a' as const;

export type Measured = number | typeof TBD | typeof NOT_APPLICABLE;

/**
 * The judge's threshold, and it is the judge's own — deliberately not
 * `DEFAULT_DEDUPE_THRESHOLD` from `src/memory/propose.ts`.
 *
 * §3 requires the metric not to use the mechanism under test, and importing the
 * mechanism's constant would be exactly that: the CORTEX arm would be scored against
 * the yardstick it was built with, and any threshold error would cancel itself out of
 * the result. This value comes from the sweep the judge publishes
 * (`bench/results/<run>/threshold-sweep.md`): the band where every declared pair is
 * caught and no undeclared pair is, measured on the corpus by U11 and re-measured by
 * `DuplicateJudge.separation()`.
 */
export const JUDGE_THRESHOLD = 0.4;

/** Thresholds the sweep reports. Spans the corpus's separation band on both sides. */
export const SWEEP_THRESHOLDS = [
  0.2, 0.24, 0.28, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.44, 0.48, 0.55,
] as const;

export interface Metrics {
  /** Acknowledged as done. The denominator for `duplicate_work_rate`. */
  totalCompleted: number;
  duplicateWorkRate: Measured;
  duplicatesFound: number;
  lostWrites: number;
  conflictingEdits: number;
  wastedTokens: number;
  totalTokens: number;
  goodputPerMinute: Measured;
  claimP50Ms: Measured;
  claimP95Ms: Measured;
  serializationRetries: Measured;
}

export interface ArmMetrics {
  arm: Arm;
  metrics: Metrics;
}

/** Only what `computeMetrics` needs, so a test can pass a stub without a cassette dir. */
export interface Judge {
  duplicatesAmong(completedInOrder: readonly string[], threshold: number): Set<string>;
}

export interface MetricsOptions {
  duplicateThreshold?: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  // Nearest-rank. With ~26 samples an interpolating definition would imply a
  // precision the sample size does not support.
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

export function computeMetrics(
  record: RunRecord,
  judge: Judge,
  options: MetricsOptions = {},
): Metrics {
  const threshold = options.duplicateThreshold ?? JUDGE_THRESHOLD;

  const done = record.acknowledged.filter((entry) => entry.result === 'done');
  const abandoned = record.acknowledged.filter((entry) => entry.result === 'abandoned');

  // §3: "semantically equivalent to an **earlier** completed intent". Completion order
  // on the simulated clock, tie-broken by task id so the order is total.
  const completedInOrder = [...done]
    .sort((a, b) => a.endVirtualMs - b.endVirtualMs || a.taskId.localeCompare(b.taskId))
    .map((entry) => entry.taskId);
  const duplicates = judge.duplicatesAmong(completedInOrder, threshold);

  const survived = new Set(record.finalState);
  const lostWrites = done.filter((entry) => !survived.has(entry.taskId)).length;

  // §3's `conflicting_edits`: file regions written by two or more agents in
  // overlapping time windows. Over work that landed, not work that was abandoned.
  let conflictingEdits = 0;
  for (let i = 0; i < done.length; i += 1) {
    for (let j = i + 1; j < done.length; j += 1) {
      const a = done[i]!;
      const b = done[j]!;
      if (a.agent === b.agent) continue;
      if (!overlaps([a.startVirtualMs, a.endVirtualMs], [b.startVirtualMs, b.endVirtualMs])) {
        continue;
      }

      for (const left of a.effects) {
        for (const right of b.effects) {
          if (left.file !== right.file) continue;
          if (left.startLine <= right.endLine && right.startLine <= left.endLine) {
            conflictingEdits += 1;
          }
        }
      }
    }
  }

  const spend = (entries: typeof done): number =>
    entries.reduce((total, entry) => total + entry.tokens.input + entry.tokens.output, 0);

  // §3: tokens spent on intents ending `abandoned` or `deduped-after-work`. The second
  // is what the judge just found: work that was done and then turned out to repeat
  // work already done. Dedupe *before* the work spends nothing and is not counted.
  const wastedTokens =
    spend(abandoned) + spend(done.filter((entry) => duplicates.has(entry.taskId)));

  const durable = record.finalState.filter((taskId) => !duplicates.has(taskId)).length;
  const minutes = record.timings.totalVirtualMs / 60_000;

  const claimSamples = record.timings.steps
    .filter((entry) => entry.kind === 'propose')
    .map((entry) => entry.realMs)
    .sort((a, b) => a - b);

  return {
    totalCompleted: done.length,
    duplicateWorkRate: done.length === 0 ? TBD : duplicates.size / done.length,
    duplicatesFound: duplicates.size,
    lostWrites,
    conflictingEdits,
    wastedTokens,
    totalTokens: spend(record.acknowledged),
    goodputPerMinute: minutes === 0 ? TBD : durable / minutes,
    // No propose step means no arbitration transaction to time — a property of the
    // NAIVE arm, not a hole in the measurement.
    claimP50Ms: claimSamples.length === 0 ? NOT_APPLICABLE : percentile(claimSamples, 0.5),
    claimP95Ms: claimSamples.length === 0 ? NOT_APPLICABLE : percentile(claimSamples, 0.95),
    serializationRetries:
      record.arm === 'naive' ? NOT_APPLICABLE : record.timings.serializationRetries,
  };
}

function cell(value: Measured, decimals = 2): string {
  if (value === TBD) return TBD;
  if (value === NOT_APPLICABLE) return '—';
  return Number.isInteger(value) && decimals === 0 ? String(value) : value.toFixed(decimals);
}

/**
 * §6's table.
 *
 * The column set follows the arms passed in rather than being hardcoded to two, so a
 * third arm (or a threshold variant) does not need a new renderer and cannot quietly
 * drop a column.
 */
export function renderSummary(rows: readonly ArmMetrics[]): string {
  const metrics: Array<[string, (m: Metrics) => string]> = [
    ['duplicate_work_rate', (m) => cell(m.duplicateWorkRate)],
    ['lost_writes', (m) => cell(m.lostWrites, 0)],
    ['conflicting_edits', (m) => cell(m.conflictingEdits, 0)],
    ['wasted_tokens', (m) => cell(m.wastedTokens, 0)],
    ['goodput (tasks/min)', (m) => cell(m.goodputPerMinute)],
    ['claim_p50 (ms)', (m) => cell(m.claimP50Ms, 0)],
    ['claim_p95 (ms)', (m) => cell(m.claimP95Ms, 0)],
    ['serialization_retries', (m) => cell(m.serializationRetries, 0)],
  ];

  const header = ['metric', ...rows.map((row) => row.arm)];
  const body = metrics.map(([name, render]) => [name, ...rows.map((row) => render(row.metrics))]);
  const widths = header.map((_col, i) =>
    Math.max(header[i]!.length, ...body.map((line) => line[i]!.length)),
  );

  const line = (cells: string[]): string =>
    `| ${cells.map((text, i) => (i === 0 ? text.padEnd(widths[i]!) : text.padStart(widths[i]!))).join(' | ')} |`;

  return [
    line(header),
    `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`,
    ...body.map(line),
  ].join('\n');
}

/** The sweep table for §6's `threshold-sweep.md`. */
export function renderSweep(judge: DuplicateJudge, thresholds: readonly number[]): string {
  const rows = judge.sweep(thresholds);
  return [
    '| threshold | pairs caught | of them declared | false positives | precision | recall |',
    '|-----------|--------------|------------------|-----------------|-----------|--------|',
    ...rows.map(
      (row) =>
        `| ${row.threshold.toFixed(2).padStart(9)} | ` +
        `${String(row.truePositives + row.falsePositives).padStart(12)} | ` +
        `${String(row.truePositives).padStart(16)} | ` +
        `${String(row.falsePositives).padStart(15)} | ` +
        `${row.precision.toFixed(3).padStart(9)} | ${row.recall.toFixed(3).padStart(6)} |`,
    ),
  ].join('\n');
}
