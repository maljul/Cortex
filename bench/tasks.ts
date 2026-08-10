/**
 * The benchmark's seeded task list. spec/06-BENCHMARK-SPEC.md §4.
 *
 * Loading is deliberately plain `readFileSync` + `JSON.parse` rather than a JSON
 * import: `tasks.json` is data the benchmark runner and the offline judge both read,
 * and §3 requires the judge not to share code with the mechanism under test. A parser
 * neither of them can configure differently is the smallest way to keep that true.
 *
 * The shares below are the unit's deliverable as much as the list is. `08` §7 ranks
 * "benchmark shows no difference" as low-likelihood and high-impact, and its response
 * is "it means task overlap is too low; increase the overlapping-task share and say so
 * in the methodology" — so the share is a number that has to exist, be measured, and
 * be published, not an adjective.
 */
import { readFileSync } from 'node:fs';

export type TaskKind = 'independent' | 'duplicate' | 'contended' | 'recall' | 'abandoned';

export interface BenchTask {
  id: string;
  kind: TaskKind;
  statement: string;
  resourceKeys: string[];
  /** Set on `duplicate` tasks; the two members of a pair share this label. */
  pair?: string;
  /** Set on `recall` tasks; the id of the task whose finding this one needs. */
  dependsOn?: string;
  /** Set on `abandoned` tasks; why the work cannot be completed. */
  abandonReason?: string;
}

interface TaskFile {
  corpus: string;
  tasks: BenchTask[];
}

const file = JSON.parse(
  readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'),
) as TaskFile;

export const CORPUS_DIR = file.corpus;
export const TASKS: readonly BenchTask[] = file.tasks;

export function tasksOfKind(kind: TaskKind): BenchTask[] {
  return TASKS.filter((task) => task.kind === kind);
}

/** The declared pairs, as `pair label -> its members`. */
export function pairs(): Map<string, BenchTask[]> {
  const found = new Map<string, BenchTask[]>();
  for (const task of tasksOfKind('duplicate')) {
    const label = task.pair;
    if (label === undefined) continue;
    found.set(label, [...(found.get(label) ?? []), task]);
  }
  return found;
}

/**
 * Tasks that name a resource key some other task also names.
 *
 * This is the share that decides whether claim contention happens at all. A list
 * where it is zero cannot distinguish the two arms no matter how the mechanism
 * behaves, because nothing ever collides.
 */
export function contendingTasks(): BenchTask[] {
  const holders = new Map<string, string[]>();
  for (const task of TASKS) {
    for (const key of task.resourceKeys) {
      holders.set(key, [...(holders.get(key) ?? []), task.id]);
    }
  }

  const contested = new Set<string>();
  for (const ids of holders.values()) {
    if (ids.length > 1) for (const id of ids) contested.add(id);
  }

  return TASKS.filter((task) => contested.has(task.id));
}

/**
 * The share of the list that is redundant work: one member of each duplicate pair.
 *
 * This is the ceiling `duplicate_work_rate` can reach in the naive arm and the floor
 * the CORTEX arm should push toward zero, so it is the number the summary table is
 * read against. Counting one member per pair rather than both is the point — the
 * first member is work that genuinely needed doing.
 */
export function redundantTaskCount(): number {
  return [...pairs().values()].reduce((total, members) => total + members.length - 1, 0);
}

export interface OverlapShares {
  total: number;
  /** Tasks sharing at least one resource key with another task. */
  contending: number;
  contendingShare: number;
  /** Tasks that duplicate work another task in the list already does. */
  redundant: number;
  redundantShare: number;
}

export function overlapShares(): OverlapShares {
  const total = TASKS.length;
  const contending = contendingTasks().length;
  const redundant = redundantTaskCount();

  return {
    total,
    contending,
    contendingShare: contending / total,
    redundant,
    redundantShare: redundant / total,
  };
}
