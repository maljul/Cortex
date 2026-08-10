/**
 * U11 — the benchmark corpus and task list. spec/06-BENCHMARK-SPEC.md §4.
 *
 * `docs/UNITS.md` U11 is done when "the corpus and the overlapping-task share exist
 * and are committed", and its silent break is too little task overlap: `08` §7 ranks
 * "benchmark shows no difference" as the low-likelihood, high-impact risk whose cause
 * is a workload that never collides, not a mechanism that does not work.
 *
 * So the structural assertions here are the cheap half. The half that earns the unit
 * is the last describe block, which **embeds all thirty statements on the live
 * endpoint and measures them**. A task list whose "semantically equivalent" pairs sit
 * outside the dedupe threshold is a task list that produces a null result, and no
 * amount of reading the statements aloud detects that — they read as equivalent to a
 * human at 0.2 and at 0.4 alike. Titan decides, so Titan is asked.
 *
 * Nothing here touches `src/memory/`; no invariant in `03` §8 is reachable from a
 * fixture. The one thing that would leak into the mechanism is a resource key that
 * does not canonicalise, since `propose` would then claim a different string than the
 * task names — checked below against the real `canonicalKey`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CORPUS_DIR,
  overlapShares,
  pairs,
  TASKS,
  tasksOfKind,
  type BenchTask,
} from '../bench/tasks.js';
import { Embedder } from '../src/embed/titan.js';
import { canonicalKey } from '../src/memory/keys.js';
import { DEFAULT_DEDUPE_THRESHOLD } from '../src/memory/propose.js';
import { cosineDistance } from './helpers/vectors.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** `file:src/a.ts` -> the path on disk inside the corpus. */
function corpusPath(resourceKey: string): string {
  return `${repoRoot}${CORPUS_DIR}/${resourceKey.slice('file:'.length)}`;
}

describe('composition (§4)', () => {
  it('is thirty tasks, in the shape §4 lists', () => {
    // §4's total said 24 while its own bullets summed to 30, reading "6 pairs" as six
    // pairs. Settled in favour of the bullets and corrected in the spec; the delta is
    // in docs/SPEC-DELTA.md. Twelve of thirty tasks being duplicates is what gives
    // duplicate_work_rate room to separate the two arms.
    expect(TASKS).toHaveLength(30);
    expect(tasksOfKind('independent')).toHaveLength(8);
    expect(tasksOfKind('duplicate')).toHaveLength(12);
    expect(tasksOfKind('contended')).toHaveLength(5);
    expect(tasksOfKind('recall')).toHaveLength(3);
    expect(tasksOfKind('abandoned')).toHaveLength(2);
  });

  it('gives every task a unique id', () => {
    expect(new Set(TASKS.map((task) => task.id)).size).toBe(TASKS.length);
  });

  it('has six pairs of exactly two members', () => {
    const found = pairs();
    expect(found.size).toBe(6);
    for (const [label, members] of found) {
      expect(members, `pair ${label}`).toHaveLength(2);
      expect(members[0]!.statement).not.toBe(members[1]!.statement);
    }
  });

  it('points every recall task at a task that exists', () => {
    const ids = new Set(TASKS.map((task) => task.id));
    for (const task of tasksOfKind('recall')) {
      expect(task.dependsOn, `${task.id} declares a dependency`).toBeTypeOf('string');
      expect(ids.has(task.dependsOn!), `${task.id} depends on ${task.dependsOn}`).toBe(true);
    }
  });

  it('gives every abandoned task a reason', () => {
    for (const task of tasksOfKind('abandoned')) {
      expect(task.abandonReason, `${task.id}`).toBeTypeOf('string');
    }
  });
});

describe('the corpus', () => {
  it('is the roughly forty source files §4 asks for', async () => {
    const { globSync } = await import('node:fs');
    const found = globSync('**/*.ts', { cwd: `${repoRoot}${CORPUS_DIR}` });
    expect(found.length).toBe(40);
  });

  it('contains every file the task list claims', () => {
    // The one that would fail silently. A task naming a path that does not exist
    // still proposes, still claims, and still contends — against a key that maps to
    // nothing, so the arm difference it was meant to produce quietly does not happen.
    for (const task of TASKS) {
      for (const key of task.resourceKeys) {
        expect(existsSync(corpusPath(key)), `${task.id} names ${key}`).toBe(true);
      }
    }
  });

  it('names every resource key in the canonical form propose will claim', () => {
    // Checked against the real `canonicalKey`, not a copy of its rules. If a task
    // names `file:./src/a.ts`, the claim lands on `file:src/a.ts` and the two tasks
    // the fixture meant to collide never do.
    for (const task of TASKS) {
      for (const key of task.resourceKeys) {
        expect(canonicalKey(key), `${task.id}: ${key}`).toBe(key);
      }
    }
  });
});

describe('the overlapping-task share — U11’s done-when', () => {
  it('has five contended tasks that genuinely share keys with each other', () => {
    const contended = tasksOfKind('contended');
    for (const task of contended) {
      const others = contended.filter((other) => other.id !== task.id);
      const shared = others.some((other) =>
        other.resourceKeys.some((key) => task.resourceKeys.includes(key)),
      );
      expect(shared, `${task.id} shares a key with another contended task`).toBe(true);
    }
  });

  it('keeps both shares high enough that a null result would mean something', () => {
    const shares = overlapShares();

    expect(shares.total).toBe(30);
    // 08 §7's response to a null result is to raise this number, so it is asserted
    // rather than merely reported — a later edit that quietly drops overlap to a
    // third fails here instead of surfacing as a benchmark that proves nothing.
    expect(shares.contendingShare).toBeGreaterThanOrEqual(0.4);
    expect(shares.redundantShare).toBeGreaterThanOrEqual(0.15);

    console.log(
      `overlap: ${shares.contending}/${shares.total} contending ` +
        `(${(shares.contendingShare * 100).toFixed(1)}%), ` +
        `${shares.redundant}/${shares.total} redundant ` +
        `(${(shares.redundantShare * 100).toFixed(1)}%)`,
    );
  });

  it('leaves the eight independent tasks sharing no key with anything', () => {
    const independent = tasksOfKind('independent');
    const otherKeys = new Set(
      TASKS.filter((task) => task.kind !== 'independent').flatMap((task) => task.resourceKeys),
    );

    for (const task of independent) {
      for (const key of task.resourceKeys) {
        expect(otherKeys.has(key), `${task.id} was meant to be the control`).toBe(false);
      }
    }
  });
});

describe('the pairs actually dedupe, measured on the live endpoint', () => {
  // One embedder, so U5's content-hash cache serves the whole block from thirty
  // invocations rather than thirty per assertion.
  const embedder = new Embedder();
  const vectors = new Map<string, number[]>();

  async function vectorFor(task: BenchTask): Promise<number[]> {
    const cached = vectors.get(task.id);
    if (cached) return cached;
    const vector = await embedder.embed(task.statement);
    vectors.set(task.id, vector);
    return vector;
  }

  async function distance(a: BenchTask, b: BenchTask): Promise<number> {
    return cosineDistance(await vectorFor(a), await vectorFor(b));
  }

  /** Every declared pair, and every combination that is not one, measured once. */
  async function separation(): Promise<{
    declared: Array<{ label: string; ids: string; distance: number }>;
    undeclared: Array<{ ids: string; distance: number; statements: string }>;
  }> {
    const declared: Array<{ label: string; ids: string; distance: number }> = [];
    for (const [label, members] of pairs()) {
      const [first, second] = members as [BenchTask, BenchTask];
      declared.push({
        label,
        ids: `${first.id}/${second.id}`,
        distance: await distance(first, second),
      });
    }

    const pairLabels = new Map(TASKS.map((task) => [task.id, task.pair]));
    const undeclared: Array<{ ids: string; distance: number; statements: string }> = [];
    for (let i = 0; i < TASKS.length; i += 1) {
      for (let j = i + 1; j < TASKS.length; j += 1) {
        const a = TASKS[i]!;
        const b = TASKS[j]!;
        if (a.pair !== undefined && a.pair === pairLabels.get(b.id)) continue;
        undeclared.push({
          ids: `${a.id}/${b.id}`,
          distance: await distance(a, b),
          statements: `"${a.statement}" vs "${b.statement}"`,
        });
      }
    }

    declared.sort((x, y) => y.distance - x.distance);
    undeclared.sort((x, y) => x.distance - y.distance);
    return { declared, undeclared };
  }

  it('separates every declared pair from every combination that is not one', async () => {
    // The assertion is separability, deliberately **not** "inside 0.28". `03` §4.2
    // marks DEDUPE_THRESHOLD `[OPEN]` and says the right value is empirical, to be
    // swept over this corpus — so a fixture asserted against today's constant would
    // be a fixture tuned to the mechanism it exists to measure, and §1 warns that a
    // database-company judge looks for exactly that.
    //
    // Separability is the threshold-independent property that makes the corpus valid:
    // if the worst true pair is closer than the closest false one, some threshold
    // classifies all thirty tasks perfectly, and U13's sweep will find it. If they
    // overlap, no threshold works and the benchmark cannot show anything.
    const { declared, undeclared } = await separation();

    const worstTrue = declared[0]!;
    const closestFalse = undeclared[0]!;

    console.log(
      `declared pairs (worst first):\n  ${declared
        .map((d) => `${d.label} ${d.ids.padEnd(9)} ${d.distance.toFixed(4)}`)
        .join('\n  ')}`,
    );
    console.log(
      `closest five that are not pairs:\n  ${undeclared
        .slice(0, 5)
        .map((d) => `${d.ids.padEnd(9)} ${d.distance.toFixed(4)}`)
        .join('\n  ')}`,
    );
    console.log(
      `separating band: (${worstTrue.distance.toFixed(4)}, ${closestFalse.distance.toFixed(4)})`,
    );

    expect(
      worstTrue.distance,
      `worst declared pair ${worstTrue.ids} (${worstTrue.distance.toFixed(4)}) must be closer ` +
        `than the closest non-pair ${closestFalse.ids} (${closestFalse.distance.toFixed(4)}): ` +
        closestFalse.statements,
    ).toBeLessThan(closestFalse.distance);
  }, 180_000);

  it('produces no false positive at the threshold that ships today', async () => {
    // Precision must hold at whatever value ships, whatever the sweep later picks:
    // deduping two tasks that were not duplicates means the CORTEX arm skips work
    // that genuinely needed doing and then reports the saving as a win it did not
    // earn. Recall is the sweep's business; a false positive is a correctness bug.
    //
    // Recall at the current default is reported rather than asserted, because it is
    // the input to `bench/results/threshold-sweep.md` and not a property of the
    // fixture. At the time of writing 0.28 sits *below* the separating band, so it
    // catches four of six — recorded in docs/SPEC-DELTA.md.
    const { declared, undeclared } = await separation();

    const falsePositives = undeclared.filter((d) => d.distance < DEFAULT_DEDUPE_THRESHOLD);
    const caught = declared.filter((d) => d.distance < DEFAULT_DEDUPE_THRESHOLD).length;

    console.log(
      `at DEDUPE_THRESHOLD ${DEFAULT_DEDUPE_THRESHOLD}: ` +
        `${caught}/${declared.length} pairs caught, ${falsePositives.length} false positives`,
    );

    expect(
      falsePositives.map((d) => `${d.ids} ${d.distance.toFixed(4)} — ${d.statements}`),
      'combinations that are not duplicates but would be deduped',
    ).toEqual([]);
  }, 180_000);
});
