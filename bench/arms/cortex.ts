/**
 * The CORTEX arm. spec/06-BENCHMARK-SPEC.md §2.
 *
 * "Shared state: CockroachDB, SERIALIZABLE. Semantic memory: same cluster, same
 * transaction. Arbitration: all-or-nothing claims. Dedupe: pre-action, same snapshot."
 *
 * This file contains **no SQL**. Every database interaction goes through
 * `src/memory/{propose,close,recall,history}.ts`, which is a repository rule and also
 * the only way the benchmark can be evidence for anything: if the arm issued its own
 * dedupe SELECT and its own claim INSERT, it would be measuring a mechanism that is
 * not the one under test, and `03` §8 invariant 1 would be broken in the harness that
 * exists to demonstrate it.
 *
 * What an agent does with each decision is the interesting part, and it is the part
 * `05` §3 says an agent must be able to act on:
 *
 * - `granted` — do the work, close, release.
 * - `deduped`  — adopt the prior outcome and move on **without spending work tokens**.
 *   This is the saving the benchmark is measuring; booking it as a completion instead
 *   would flatter the arm and invert `duplicate_work_rate`'s meaning.
 * - `blocked`  — re-plan: the task goes to the back of this agent's own queue and is
 *   retried after a backoff, up to `MAX_ATTEMPTS`. Never a poll — §5 forbids turning
 *   the fleet into a queue, and the holder's identity arrives with the decision
 *   (invariant 3), which is what makes re-planning possible at all.
 */
import { close } from '../../src/memory/close.js';
import { completedIntents } from '../../src/memory/history.js';
import { propose, type ProposeResult } from '../../src/memory/propose.js';
import { recall } from '../../src/memory/recall.js';
import { step, type AgentProgram, type Step } from '../scheduler.js';
import type { BenchTask } from '../tasks.js';

import {
  AGENT_START_STEP_MS,
  MAX_ATTEMPTS,
  toAcknowledged,
  type AssignedAgent,
  type BenchContext,
} from './shared.js';

/** Who holds an intent, so a `blocked` decision can name a task rather than a UUID. */
interface Holder {
  agent: string;
  taskId: string;
}

export interface CortexArm {
  repoId: string;
  programs(agents: readonly AssignedAgent[]): AgentProgram[];
  finalState(): Promise<string[]>;
  notes(): string[];
}

export function createCortexArm(ctx: BenchContext, repoId: string): CortexArm {
  const holders = new Map<string, Holder>();
  const byStatement = new Map(ctx.tasks.map((task) => [task.statement, task.id]));

  function describeHolder(intentId: string | undefined): Holder {
    if (intentId === undefined) return { agent: 'unknown', taskId: 'unknown' };
    return holders.get(intentId) ?? { agent: 'unknown', taskId: 'unknown' };
  }

  async function* program(agent: AssignedAgent): AsyncGenerator<Step, void, void> {
    const pending: Array<{ task: BenchTask; attempt: number }> = agent.queue.map((task) => ({
      task,
      attempt: 1,
    }));

    for (;;) {
      const item = pending.shift();
      if (item === undefined) break;
      const { task, attempt } = item;

      let embedding: number[] = [];
      yield step('recall', task.id, attempt, ctx.recallMs(task, attempt), async () => {
        embedding = await ctx.embed(task.statement);
        const found = await recall({ repoId, embedding });
        return { outcome: 'ok', detail: { findings: found.length } };
      });

      let decision: ProposeResult | undefined;
      yield step(
        'propose',
        task.id,
        attempt,
        ctx.arbitrateMs(task, attempt, 'propose'),
        async () => {
          decision = await propose({
            repoId,
            agentId: agent.id,
            statement: task.statement,
            resourceKeys: task.resourceKeys,
            embedding,
          });

          if (decision.decision === 'granted') {
            holders.set(decision.intentId, { agent: agent.id, taskId: task.id });
            return { outcome: 'granted', detail: { keys: decision.keys.length } };
          }

          if (decision.decision === 'deduped') {
            const of = describeHolder(decision.of);
            return {
              outcome: 'deduped',
              detail: {
                ofTask: of.taskId,
                holder: decision.holder,
                status: decision.status,
                // Rounded: the raw distance is a float rendered by the server, and a
                // determinism assertion should not turn on its last decimal place.
                distance: Math.round(decision.distance * 10_000) / 10_000,
              },
            };
          }

          const first = decision.contested[0];
          return {
            outcome: 'blocked',
            detail: {
              keys: decision.contested.length,
              holder: first?.holder ?? 'unknown',
              holderTask: describeHolder(first?.intentId).taskId,
            },
          };
        },
      );

      if (decision === undefined) throw new Error('propose step did not run');

      if (decision.decision === 'deduped') continue;

      if (decision.decision === 'blocked') {
        // Re-plan, not poll: back of this agent's own queue, and the next attempt's
        // recall carries a backoff. A task that stays blocked to the cap is given up
        // and is deliberately *not* acknowledged — no work was done, so counting it
        // as either completed or wasted would be a fabricated number.
        if (attempt < MAX_ATTEMPTS) pending.push({ task, attempt: attempt + 1 });
        continue;
      }

      const granted = decision;
      let workStart = 0;
      let output: Awaited<ReturnType<BenchContext['plan']>> | undefined;
      yield step('work', task.id, attempt, ctx.workMs(task), async (at) => {
        workStart = at;
        output = await ctx.plan(task);
        return { outcome: 'ok', detail: { files: output.edits.length } };
      });

      const closeMs = ctx.arbitrateMs(task, attempt, 'close');
      yield step('close', task.id, attempt, closeMs, async (at) => {
        if (output === undefined) throw new Error('work step did not run');
        const result = task.kind === 'abandoned' ? 'abandoned' : 'done';
        const files = [...new Set(output.edits.map((edit) => edit.file))];

        const closed = await close({
          repoId,
          intentId: granted.intentId,
          result,
          idempotencyKey: `${agent.id}:${task.id}:${attempt}`,
          filesChanged: files,
          notes: output.note,
          tokensSpent: output.tokens.input + output.tokens.output,
        });

        ctx.acknowledge(
          toAcknowledged(
            task,
            agent.id,
            { effects: output.edits, note: output.note, tokens: output.tokens },
            { startVirtualMs: workStart, endVirtualMs: at + closeMs },
          ),
        );

        return { outcome: result, detail: { releasedKeys: closed.releasedKeys } };
      });
    }
  }

  return {
    repoId,

    programs(agents) {
      return agents.map((agent) => ({
        id: agent.id,
        startVirtualMs: agent.index * AGENT_START_STEP_MS,
        steps: program(agent),
      }));
    },

    async finalState() {
      const closed = await completedIntents({ repoId });
      return closed
        .filter((intent) => intent.status === 'done')
        .map((intent) => byStatement.get(intent.statement) ?? `unmapped:${intent.statement}`)
        .sort();
    },

    notes() {
      return [
        'CORTEX recall reads `findings`, which nothing populates yet: consolidation ' +
          '(03 §4.4) is changefeed-driven and not built. Every recall in this arm ' +
          'therefore returns 0, while the NAIVE arm reads its own local note store and ' +
          'returns real hits. The comparison understates CORTEX on the three ' +
          'recall-dependent tasks; it is not corrected here, because inventing a ' +
          'findings writer would mean benchmarking a mechanism that does not exist.',
      ];
    },
  };
}
