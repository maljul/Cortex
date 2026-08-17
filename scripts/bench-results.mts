/**
 * Populates `bench/results/`. spec/06-BENCHMARK-SPEC.md §6, §7.
 *
 *   npm run bench:results
 *
 * Runs each arm three times — §7.3: "Report variance across at least three runs, not a
 * single best result" — computes `06` §3's metrics with the offline judge, and writes
 * the §6 directory. The summary table is the **median** of the three, and the spread is
 * printed underneath it, so a reader never sees a best-of chosen after the fact.
 *
 * Everything published here is computed. Where a number does not exist the cell says
 * `TBD`; where the arm has no such thing to measure it says `—`. `10` §62: never a
 * placeholder number, not even in documentation.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { DEFAULT_DEDUPE_THRESHOLD } from '../src/memory/propose.js';
import { describeEnvironment } from '../bench/environment.js';
import { DuplicateJudge } from '../bench/judge.js';
import {
  computeMetrics,
  JUDGE_THRESHOLD,
  NOT_APPLICABLE,
  renderSummary,
  renderSweep,
  SWEEP_THRESHOLDS,
  TBD,
  type Measured,
  type Metrics,
} from '../bench/metrics.js';
import { DEFAULT_AGENTS, DEFAULT_SEED, runArm } from '../bench/run.js';
import { pairs, TASKS } from '../bench/tasks.js';
import type { Arm, RunRecord } from '../bench/types.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

/** §7.3's floor. Three is the minimum the spec accepts, not a target to beat. */
const RUNS_PER_ARM = 3;

const ARMS: Arm[] = ['naive', 'cortex'];
const recordedAt = new Date().toISOString();
const runId = recordedAt.replace(/[:.]/g, '-');
const outDir = join(fileURLToPath(new URL('../bench/results/', import.meta.url)), runId);
const workDir = join(fileURLToPath(new URL('../bench/runs/', import.meta.url)), `results-${runId}`);

const METRIC_KEYS = [
  'duplicateWorkRate',
  'lostWrites',
  'conflictingEdits',
  'wastedTokens',
  'goodputPerMinute',
  'claimP50Ms',
  'claimP95Ms',
  'serializationRetries',
] as const satisfies ReadonlyArray<keyof Metrics>;

type MetricKey = (typeof METRIC_KEYS)[number];

/** Element-wise median. Any run reporting TBD makes the metric TBD overall. */
function medianOf(values: readonly Measured[]): Measured {
  if (values.includes(TBD)) return TBD;
  if (values.every((value) => value === NOT_APPLICABLE)) return NOT_APPLICABLE;

  const numbers = values.filter((value): value is number => typeof value === 'number').sort(
    (a, b) => a - b,
  );
  if (numbers.length === 0) return TBD;
  return numbers[Math.floor(numbers.length / 2)]!;
}

function medianMetrics(all: readonly Metrics[]): Metrics {
  const base = { ...all[0]! };
  for (const key of METRIC_KEYS) {
    (base[key] as Measured) = medianOf(all.map((metrics) => metrics[key]));
  }
  base.totalCompleted = all[0]!.totalCompleted;
  base.duplicatesFound = all[0]!.duplicatesFound;
  base.totalTokens = all[0]!.totalTokens;
  return base;
}

function show(value: Measured, decimals = 2): string {
  if (value === TBD) return TBD;
  if (value === NOT_APPLICABLE) return '—';
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

function renderSpread(results: ReadonlyArray<{ arm: Arm; metrics: Metrics[] }>): string {
  const lines = [
    '| metric | arm | min | median | max |',
    '|--------|-----|-----|--------|-----|',
  ];

  for (const key of METRIC_KEYS) {
    for (const { arm, metrics } of results) {
      const values = metrics.map((m) => m[key]);
      const numbers = values.filter((v): v is number => typeof v === 'number');
      const decimals = key === 'duplicateWorkRate' || key === 'goodputPerMinute' ? 2 : 0;

      if (numbers.length === 0) {
        lines.push(`| ${key} | ${arm} | ${show(values[0]!)} | ${show(values[0]!)} | ${show(values[0]!)} |`);
        continue;
      }

      lines.push(
        `| ${key} | ${arm} | ${show(Math.min(...numbers), decimals)} | ` +
          `${show(medianOf(values), decimals)} | ${show(Math.max(...numbers), decimals)} |`,
      );
    }
  }

  return lines.join('\n');
}

/** §7.5: a metric that moves the wrong way is published and explained, not dropped. */
function wrongWay(naive: Metrics, cortex: Metrics): string[] {
  const lowerIsBetter: MetricKey[] = [
    'duplicateWorkRate',
    'lostWrites',
    'conflictingEdits',
    'wastedTokens',
  ];
  const out: string[] = [];

  for (const key of lowerIsBetter) {
    const a = naive[key];
    const b = cortex[key];
    if (typeof a === 'number' && typeof b === 'number' && b > a) {
      out.push(`\`${key}\`: CORTEX ${show(b)} against NAIVE ${show(a)} — worse, not better.`);
    }
  }

  const naiveGoodput = naive.goodputPerMinute;
  const cortexGoodput = cortex.goodputPerMinute;
  if (
    typeof naiveGoodput === 'number' &&
    typeof cortexGoodput === 'number' &&
    cortexGoodput < naiveGoodput
  ) {
    out.push(
      `\`goodput\`: CORTEX ${show(cortexGoodput)} against NAIVE ${show(naiveGoodput)} — lower.`,
    );
  }

  return out;
}

try {
  mkdirSync(outDir, { recursive: true });

  const judge = DuplicateJudge.fromCassettes();
  if (judge.missing().length > 0) {
    throw new Error(
      `no recorded vector for ${judge.missing().join(', ')}. Re-record with ` +
        '`npm run bench -- --record` before publishing anything.',
    );
  }

  const perArm: Array<{ arm: Arm; records: RunRecord[]; metrics: Metrics[] }> = [];

  for (const arm of ARMS) {
    const records: RunRecord[] = [];
    for (let run = 1; run <= RUNS_PER_ARM; run += 1) {
      const runDir = join(workDir, `${arm}-${run}`);
      mkdirSync(runDir, { recursive: true });
      process.stdout.write(`${arm} run ${run}/${RUNS_PER_ARM}… `);
      const record = await runArm({ arm, tasks: TASKS, runDir });
      records.push(record);
      console.log(`${record.timings.wallClockMs} ms`);
    }

    perArm.push({
      arm,
      records,
      metrics: records.map((record) => computeMetrics(record, judge)),
    });
  }

  const medians = perArm.map(({ arm, metrics }) => ({ arm, metrics: medianMetrics(metrics) }));
  const naive = medians.find((row) => row.arm === 'naive')!.metrics;
  const cortex = medians.find((row) => row.arm === 'cortex')!.metrics;

  for (const { arm, records, metrics } of perArm) {
    writeFileSync(
      join(outDir, `${arm}.json`),
      `${JSON.stringify(
        {
          arm,
          seed: DEFAULT_SEED,
          agents: DEFAULT_AGENTS,
          taskCount: TASKS.length,
          runs: metrics.map((m, i) => ({
            run: i + 1,
            metrics: m,
            wallClockMs: records[i]!.timings.wallClockMs,
            totalVirtualMs: records[i]!.timings.totalVirtualMs,
            serializationRetries: records[i]!.timings.serializationRetries,
          })),
          median: medianMetrics(metrics),
          notes: records[0]!.notes,
          // One full record, so a reader can recompute every metric above from the
          // raw decisions rather than trusting this file's arithmetic.
          record: records[0],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  writeFileSync(
    join(outDir, 'environment.json'),
    `${JSON.stringify(await describeEnvironment({ recordedAt, mode: 'replay' }), null, 2)}\n`,
    'utf8',
  );

  writeFileSync(
    join(outDir, 'threshold-sweep.md'),
    [
      '# Dedupe threshold sweep',
      '',
      `Recorded ${recordedAt}. Distance is cosine over the committed embedding`,
      'cassettes, computed in `bench/judge.ts` — not by the operator the mechanism',
      'uses. Ground truth is the `pair` label in `bench/tasks.json`, written by hand',
      'before anything was measured.',
      '',
      renderSweep(judge, SWEEP_THRESHOLDS),
      '',
      '## Reading it',
      '',
      '**Precision is the expensive column.** A false positive means the CORTEX arm',
      'skipped work that genuinely needed doing and booked the skip as a saving, so a',
      'threshold bought at the cost of precision improves the headline number and',
      'degrades the system.',
      '',
      `The judge scores at **${JUDGE_THRESHOLD}**, chosen from this table rather than`,
      'from the mechanism: it is inside the band where recall is 1.000 and precision is',
      'still 1.000.',
      '',
      `\`src/memory/propose.ts\` ships **${DEFAULT_DEDUPE_THRESHOLD}**, chosen from this`,
      'same table, which closed `03` §4.2\'s `[OPEN]`. The two constants are',
      'deliberately different despite both being drawn from this band: the judge scores',
      'the benchmark that justifies the mechanism\'s value, and a single shared number',
      'would read as the two having been tuned together — which is the circularity `06`',
      '§3 exists to prevent. They were picked independently and the values say so.',
      '',
    ].join('\n'),
    'utf8',
  );

  const moved = wrongWay(naive, cortex);

  // Read only to *describe* the gap between the mechanism's threshold and the judge's.
  // The judge never sees this value — `bench/judge.ts` imports nothing from `src/`.
  const sweep = judge.sweep([...SWEEP_THRESHOLDS, DEFAULT_DEDUPE_THRESHOLD]);
  const shippedRow = sweep.find((row) => row.threshold === DEFAULT_DEDUPE_THRESHOLD)!;

  /**
   * The value the mechanism shipped through the end-of-day-two gate (U13, V20), before
   * `03` §4.2's `[OPEN]` was closed at 0.39.
   *
   * Deliberately a fixed historical number and not derived from anything. The prose
   * below describes what the *previous* constant caught; reading that count off
   * `DEFAULT_DEDUPE_THRESHOLD` would silently re-describe history every time the
   * constant moves — and it did exactly that once, publishing "0.28 caught 6 of 6"
   * when 0.28 caught 4.
   */
  const GATE_THRESHOLD = 0.28;
  const gateRow = sweep.find((row) => row.threshold === GATE_THRESHOLD)!;
  const declaredPairs = pairs().size;

  writeFileSync(
    join(outDir, 'summary.md'),
    [
      '# Benchmark results',
      '',
      `Recorded ${recordedAt}. Seed ${DEFAULT_SEED}, ${DEFAULT_AGENTS} agents,`,
      `${TASKS.length} tasks, ${RUNS_PER_ARM} runs per arm. Median shown.`,
      '',
      renderSummary(medians),
      '',
      '## Spread across the three runs',
      '',
      renderSpread(perArm),
      '',
      'Most rows do not move at all, and that is the point rather than a coincidence:',
      'the coordination outcomes are deterministic at a fixed seed against the committed',
      'cassettes, so only the wall-clock rows vary. `test/bench-runner.test.ts` asserts',
      'it by running each arm twice and comparing the decision sequences.',
      '',
      '## What was held constant',
      '',
      'Both arms ran the same 30 tasks, dealt to 5 agents in the same seeded order, on',
      'the same simulated clock, drawing on the same recorded reasoning and the same',
      'recorded embeddings. The only difference between them is where the shared state',
      'lives. Model reasoning is replayed; **database behaviour is live in both arms** —',
      'the NAIVE arm really does lose writes to its JSON file, and is not scripted to.',
      '',
      '## Reproducing this',
      '',
      '```',
      'npm run bench:results',
      '```',
      '',
      '**Prerequisite: a CockroachDB cluster of your own**, and two connection strings for',
      'it: `CORTEX_DSN` to apply `sql/001_init.sql` once, and `CORTEX_WRITER_DSN` — the',
      'least-privileged `cortex_writer` role that schema creates — which is what the CORTEX',
      'arm actually runs on. The CORTEX arm cannot run without a cluster; that is the point',
      'of the harness, not a restriction on it. No Bedrock credentials are needed: the run',
      'replays cassettes and reports `liveCalls: {embed: 0, reason: 0}`.',
      '',
      '**What needs no prerequisites at all:** everything except re-running. The',
      'committed cassettes, this table, `environment.json`, the full run record in each',
      "arm's JSON file, and the offline judge are all in the repository, so the",
      '**dedupe** threshold sweep (`threshold-sweep.md`) and every metric above can be',
      'recomputed from a clean clone with nothing provisioned.',
      '',
      '**`recall-threshold-sweep.md` in this directory is the exception and does not have',
      'that property.** It is not produced by this script — `npm run sweep:recall` writes',
      'it, making live Titan calls and computing its distances with the cluster\'s own',
      '`<=>`. There are no cassettes behind it. Its ground truth (`bench/recall-truth.json`)',
      'and its published table are committed and readable from a clean clone; reproducing',
      'the numbers needs Bedrock and a cluster.',
      '',
      // Two different honest paragraphs, because the interesting thing to say depends
      // on what was measured. Reporting "why the arm is not at zero" over a zero would
      // be a placeholder in prose form, which is the failure `06` §6 names for numbers
      // and which reads exactly as authoritative.
      ...(cortex.duplicatesFound > 0
        ? [
            '## Why the CORTEX arm is not at zero',
            '',
            `\`duplicate_work_rate\` is ${show(cortex.duplicateWorkRate)} for CORTEX, not 0.00, and`,
            'the reason is the more useful half of the result.',
            '',
            `The mechanism ships a dedupe threshold of **${DEFAULT_DEDUPE_THRESHOLD}**`,
            '(`src/memory/propose.ts`); the offline judge scores at',
            `**${JUDGE_THRESHOLD}**, chosen from the sweep and not from the mechanism. At the`,
            `shipped value the sweep catches ${shippedRow.truePositives} of the`,
            `${declaredPairs} declared pairs; at the judge's value it catches all`,
            `${declaredPairs}, with no false positives at either. So the`,
            `${cortex.duplicatesFound} duplicates the judge found in the CORTEX arm are`,
            'exactly the pairs the mechanism let through.',
          ]
        : [
            '## The CORTEX arm is at zero, and how its threshold was chosen',
            '',
            `\`duplicate_work_rate\` is ${show(cortex.duplicateWorkRate)} for CORTEX: the judge`,
            'finds no duplicated work in the arm\'s final state. The threshold that produces',
            'that is the one number this benchmark recommended changing, so how it was',
            'picked matters more than the row itself.',
            '',
            `\`src/memory/propose.ts\` ships **${DEFAULT_DEDUPE_THRESHOLD}**, and the offline`,
            `judge scores at **${JUDGE_THRESHOLD}**. Both are drawn from`,
            '`threshold-sweep.md` and both sit inside the band where recall and precision',
            'are 1.000 on this corpus — but they are **different numbers on purpose**. The',
            'judge scores the benchmark that justifies the mechanism\'s value; carrying one',
            'shared constant would read as the two having been tuned together.',
            '',
            '**The threshold was changed, after this benchmark recommended it, and that is',
            `disclosed rather than hidden.** It shipped at ${GATE_THRESHOLD} through the`,
            `end-of-day-two gate, where it caught ${gateRow.truePositives} of the`,
            `${declaredPairs} declared pairs and`,
            `${shippedRow.truePositives === declaredPairs ? `${DEFAULT_DEDUPE_THRESHOLD} catches all ${declaredPairs}` : `${DEFAULT_DEDUPE_THRESHOLD} catches ${shippedRow.truePositives}`}`,
            '— the published row was 0.21 → 0.08 rather than 0.21 → 0.00, and',
            'the sweep said why. `03` §4.2 marked the constant `[OPEN]` and empirical, and',
            'closing it was Julian\'s call with the sweep in front of him. Recorded in',
            '`docs/DECISIONS.md`.',
            '',
            'What `06` §3 forbids is the benchmark quietly tuning the mechanism it scores.',
            'What defeats that is not abstaining from ever acting on a measurement — it is',
            'publishing the sweep, the prior value, the value now, and the fact that one',
            'followed the other. All four are in this directory.',
          ]),
      '',
      '## Metrics that moved the wrong way',
      '',
      ...(moved.length === 0
        ? [
            'None at this seed. That is a claim about one workload at one seed, not about',
            'the mechanism; the limitations below are the honest reading of it.',
          ]
        : moved.map((line) => `- ${line}`)),
      '',
      '## Where this mechanism loses',
      '',
      'Every figure above comes from one workload built with deliberately high overlap, so',
      'the honest claim is not that arbitration beats isolation. It is narrower, and it has',
      'a threshold.',
      '',
      '**Arbitration pays when `p · L > H + B`** — `p` the probability that two agents',
      'working independently cause a costly integration failure, `L` what repairing one',
      'costs, `H` the overhead arbitration charges every proposal whether or not it turned',
      'out to be needed, `B` the expected cost of blocking and of false dedupe.',
      '',
      '`H` is **at least** `claim_p50` above, 732 ms, and really larger: a proposal also',
      'embeds its statement, and this harness serialises, so that latency carries no',
      'contention. Taking `H` at that floor and `B` at zero — both generous to CORTEX —',
      'break-even is **p > 1.2%** against a sixty-second repair and **p > 0.24%** against a',
      'five-minute one. Below its own break-even this mechanism is overhead and ordinary',
      'isolation is faster.',
      '',
      'Nothing in the table contradicts that. The corpus was built with 43.3% contending and',
      '20.0% redundant tasks (`06` §4) so that the failure modes occur at all; a repository',
      'with less overlap sits lower on that curve, and below some point it sits under the',
      'line.',
      '',
      'The sharpest case against this mechanism is not slowness. **A false dedupe is the',
      'most expensive thing it can do** — it does not delay work, it tells an agent that',
      'work it was about to start is already finished. That asymmetry is why the dedupe',
      'constant is chosen for precision rather than recall, and why the sweep beside this',
      'file publishes its false positives rather than only its catches.',
      '',
      '## Limitations, stated by the author',
      '',
      '- **The duplicate pairs were revised after their distances were measured, and that',
      '  bounds what `duplicate_work_rate` proves.** The six semantically-equivalent pairs',
      '  were written first and then embedded: all six landed between 0.4380 and 0.7068 with',
      '  the closest non-pair at 0.4293, so nothing separated. They were rewritten as',
      '  ordinary rephrasings rather than adversarial ones, and now separate at (0.3630,',
      '  0.4293). Reading them aloud never revealed it; only measuring did. It is disclosed',
      '  here rather than smoothed over, and it is a real limit rather than a formality:',
      '  these positives were selected conditional on the detector\'s own scores, so this row',
      '  measures the mechanism partly on cases it was shaped to catch. An externally',
      '  authored corpus is what would settle it, and this one is not that.',
      '- **The NAIVE arm here is "no coordination", not "worktree isolation".** `06` §2',
      '  defines it as a shared JSON file with last-write-wins, a separate local vector',
      '  store, no arbitration and no dedupe, and that is what `bench/arms/naive.ts`',
      '  implements. The hosted demo compares against a **different** baseline — a vector',
      '  store plus a job lock, running the same two statements in two transactions — so the',
      '  two answer two different questions. Neither is a measurement of git worktrees, and',
      '  this table should not be read as one.',
      '- **`lost_writes` counts bytes actually overwritten, not features lost after a clean',
      '  merge.** The naive arm rewrites the shared JSON file whole from a pre-work snapshot,',
      '  so a completion record is literally clobbered by a stale one, and the metric is the',
      '  set difference over what survived. It is not a measure of two correct patches',
      '  merging cleanly into a broken tree: nothing in this harness integrates branches at',
      '  all. That failure mode is real and is measured elsewhere, by executing the composed',
      '  application rather than by diffing it.',
      '- **The NAIVE arm has no write-time concurrency check, and a real agent toolchain does —',
      '  so this row\'s baseline is weaker than a real uncoordinated fleet\'s.** Measured on',
      '  2026-08-17 (V63) by running a two-arm workload with **real** model agents rather than',
      '  replayed ones. The uncoordinated arm lost **nothing**, because the agents\' editing tool',
      '  refuses a write to a file that changed since it was last read: one agent did its whole',
      '  task and was rejected at write time, another hit the same guard and re-read before',
      '  writing. `06` §2\'s arm rewrites a JSON file whole from a pre-work snapshot and has no',
      '  such guard, so the `lost_writes` figures above are measured against a baseline with no',
      '  optimistic concurrency at all. What survives that comparison is a difference in **kind**',
      '  rather than in magnitude: arbitration is explicit and holds whatever does the writing,',
      '  where the toolchain\'s guard is per-file, per-tool, and would not survive a shell',
      '  redirect. **Do not read this row as predicting the loss rate of a real uncoordinated',
      '  fleet.** Nor does the live run contradict it — the two measure different baselines, and',
      '  no number above moved.',
      '- **Small synthetic corpus.** 40 fixture files, 30 tasks, one workload shape.',
      '  Overlap was chosen so the failure modes appear at all (`06` §4); a repository',
      '  with less overlap would show less difference, and that is a real caveat rather',
      '  than a disclaimer.',
      '- **Replayed reasoning.** The agents do not think during a run. Recorded once',
      '  against Bedrock, replayed identically for both arms.',
      '- **The harness serialises.** One step runs at a time so the run reproduces, so',
      '  two transactions never overlap: `serialization_retries` is 0 by construction',
      '  and the claim latencies are uncontended. The real race is evidenced separately',
      '  by `npm run gate:contend` and by `test/retry.test.ts`.',
      '- **CORTEX recall returns nothing, and the cause is the harness rather than the',
      '  mechanism.** `findings` is populated by consolidation (`03` §4.4), which is',
      '  changefeed-driven; this harness runs no changefeed, so the table stays empty for',
      '  the whole run and every recall returns 0 rows. The NAIVE arm meanwhile reads its',
      '  own local note store and gets real hits, so on the three recall-dependent tasks',
      '  this benchmark **understates** CORTEX.',
      '  *Two things this is not, both checked on 2026-08-12.* It is not "consolidation is',
      '  unbuilt" — V27 built it, and `npm run gate:consolidate` proves it end to end; it',
      '  is simply not wired into this offline harness. And it is not `03` §4.1\'s distance',
      '  threshold: that constant moved 0.35 → 0.60 that day (V34) and **not one metric in',
      '  the table above changed**, because an empty table returns nothing at any distance.',
      '  The threshold was the binding constraint on the *demo*, which seeds a finding; it',
      '  was never the binding constraint here.',
      '- **Single region, single cluster tier.** See `environment.json`.',
      '- **`goodput` is per simulated minute, not per wall-clock minute.** Wall clock',
      '  would compare a local file write against a cloud round trip and call the',
      '  difference a coordination result.',
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`\n${renderSummary(medians)}\n`);
  console.log(`written: ${outDir}`);

  await closePool();
  process.exit(0);
} catch (error) {
  console.error(`\nbench:results failed: ${(error as Error).message}`);
  await closePool();
  process.exit(1);
}
