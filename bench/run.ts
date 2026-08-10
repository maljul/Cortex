/**
 * One arm, start to finish. spec/06-BENCHMARK-SPEC.md §5, §6.
 *
 * The entry point behind `npm run bench`. Everything that makes a run reproducible is
 * decided here and nowhere else: the seed, the fleet size, the task assignment, the
 * cassette mode and the tenant. Nothing downstream of this function reads a clock or
 * draws a random number.
 *
 * The CORTEX arm runs against a **fresh `repo_id` per run**, generated rather than
 * reused. That is not tidiness: `repo_id` is the tenant boundary (invariant 5), so a
 * fresh one is an empty tenant, and an empty tenant is what makes two runs of the same
 * seed produce the same decisions. Re-running into a populated tenant would dedupe
 * every task against the previous run's intents and report a duplicate-work rate of
 * roughly one.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CassetteStore, type CassetteMode } from './cassettes.js';
import { schedule } from './scheduler.js';
import { TASKS, type BenchTask } from './tasks.js';
import { assign, assignedOrder, BenchContext } from './arms/shared.js';
import { createCortexArm } from './arms/cortex.js';
import { createNaiveArm } from './arms/naive.js';
import type { Arm, RunRecord } from './types.js';

/** The shipped seed. Published, so the numbers can be reproduced exactly. */
export const DEFAULT_SEED = 1729;

/** §4: "Fleet: 5 agents, started simultaneously, each pulling from the shared task list." */
export const DEFAULT_AGENTS = 5;

/**
 * Records a cassette for every task, ahead of any run. `--record` (§5).
 *
 * Deliberately a prefetch rather than a side effect of running an arm. If cassettes
 * were recorded as the arms happened to need them, the CORTEX arm would never record
 * the tasks it dedupes and the NAIVE arm would never record what it skips — so the
 * library would depend on the coordination layer, and re-recording after a threshold
 * change would silently leave holes that only surface as a `CassetteMiss` weeks later.
 * Every task in the list gets a cassette, whether or not any arm reaches it.
 */
export async function recordCassettes(
  tasks: readonly BenchTask[] = TASKS,
): Promise<{ tasks: number; embedCalls: number; reasonCalls: number }> {
  const store = new CassetteStore('record');
  const ctx = new BenchContext({ arm: 'naive', seed: DEFAULT_SEED, store, tasks });

  for (const task of tasks) {
    await ctx.embed(task.statement);
    await ctx.plan(task);
  }

  return {
    tasks: tasks.length,
    embedCalls: ctx.invocations.embed,
    reasonCalls: ctx.invocations.reason,
  };
}

export interface RunOptions {
  arm: Arm;
  seed?: number;
  agents?: number;
  /** Defaults to the whole seeded list; a subset keeps a smoke run cheap. */
  tasks?: readonly BenchTask[];
  mode?: CassetteMode;
  /** Working directory for the NAIVE arm's shared file. A fresh one per run. */
  runDir?: string;
  /** CORTEX tenant. Supply one only to inspect a run's rows afterwards. */
  repoId?: string;
}

export async function runArm(options: RunOptions): Promise<RunRecord> {
  const seed = options.seed ?? DEFAULT_SEED;
  const agentCount = options.agents ?? DEFAULT_AGENTS;
  const tasks = options.tasks ?? TASKS;
  const mode = options.mode ?? 'replay';

  const runDir = options.runDir ?? mkdtempSync(join(tmpdir(), 'cortex-bench-'));
  mkdirSync(runDir, { recursive: true });

  const store = new CassetteStore(mode);
  const ctx = new BenchContext({ arm: options.arm, seed, store, tasks });
  const fleet = assign(tasks, agentCount, seed);

  const arm =
    options.arm === 'cortex'
      ? createCortexArm(ctx, options.repoId ?? randomUUID())
      : createNaiveArm(ctx, runDir);

  const startedReal = performance.now();
  const scheduled = await schedule(arm.programs(fleet));
  const wallClockMs = performance.now() - startedReal;

  const finalState = await arm.finalState();
  const keys = store.keys;

  return {
    arm: options.arm,
    seed,
    agents: agentCount,
    taskIds: assignedOrder(fleet),
    cassettes: {
      mode,
      reasonKeys: keys.reason,
      embedKeys: keys.embed,
      liveCalls: ctx.invocations,
    },
    decisions: scheduled.decisions,
    acknowledged: ctx.acknowledged,
    finalState,
    notes: [...arm.notes(), ...ctx.notes],
    timings: {
      steps: scheduled.timings,
      wallClockMs: Math.round(wallClockMs),
      totalVirtualMs: scheduled.totalVirtualMs,
    },
  };
}
