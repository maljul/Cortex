/**
 * The deterministic interleaver. spec/06-BENCHMARK-SPEC.md §5.
 *
 * §5 asks for "simulated clock offsets so contention is forced deterministically
 * rather than hoped for". This is that clock. Five agents each hold a *virtual*
 * clock; the scheduler repeatedly runs one step of whichever agent's clock is
 * furthest behind, then advances that agent's clock by the step's virtual duration.
 * Ties go to the lower agent index, so the order is total.
 *
 * The consequence worth being explicit about: **only one step is ever in flight**, so
 * the two arms are contended but not concurrent. Contention is real — agent B really
 * does find agent A's claim in the `claims` table, and the NAIVE arm really does
 * clobber a save — but two transactions never overlap inside CockroachDB, so this
 * harness produces no 40001 retries and its `claim_p50` is an uncontended latency.
 * That is a deliberate trade: §5's reproducibility requirement is incompatible with
 * racing five processes, and the race is already proven elsewhere — `npm run
 * gate:contend` (U6) contends two real processes for one key, and `test/retry.test.ts`
 * forces a real 40001. The benchmark measures wasted work, not lock throughput.
 * U13 must report `serialization_retries` as what it measures here, not as a claim
 * about the mechanism under load.
 *
 * **Contract for an agent program:** all work happens inside `Step.run`. The generator
 * body between two `yield`s runs while the scheduler holds the agent's turn and before
 * the next step's virtual duration is charged, so an `await` there would be work
 * happening at no simulated cost and outside the interleaving.
 */
import type { Decision, StepKind, StepTiming } from './types.js';

export interface StepOutcome {
  outcome: string;
  detail?: Record<string, unknown>;
}

export interface Step {
  kind: StepKind;
  taskId: string;
  /** 1 for a first attempt; higher after a blocked re-plan. */
  attempt: number;
  /** How long this step takes on the simulated clock. */
  virtualMs: number;
  /** `startVirtualMs` is this step's position on the simulated clock, not a real time. */
  run(startVirtualMs: number): Promise<StepOutcome>;
}

export interface AgentProgram {
  id: string;
  /** §5's simulated clock offset: agents do not all start on the same instant. */
  startVirtualMs: number;
  steps: AsyncGenerator<Step, void, void>;
}

export interface ScheduleResult {
  decisions: Decision[];
  timings: StepTiming[];
  totalVirtualMs: number;
}

export async function schedule(programs: readonly AgentProgram[]): Promise<ScheduleResult> {
  const agents = programs.map((program, index) => ({
    program,
    index,
    clock: program.startVirtualMs,
    done: false,
  }));

  const decisions: Decision[] = [];
  const timings: StepTiming[] = [];
  let seq = 0;

  for (;;) {
    const ready = agents.filter((agent) => !agent.done);
    if (ready.length === 0) break;

    // Furthest behind on the simulated clock goes next; index breaks the tie, so the
    // order never depends on how the runtime happens to have ordered the array.
    ready.sort((a, b) => a.clock - b.clock || a.index - b.index);
    const agent = ready[0]!;

    const next = await agent.program.steps.next();
    if (next.done === true) {
      agent.done = true;
      continue;
    }

    const step = next.value;
    const startVirtualMs = agent.clock;
    const startedReal = performance.now();
    const result = await step.run(startVirtualMs);
    const realMs = performance.now() - startedReal;

    agent.clock = startVirtualMs + step.virtualMs;
    seq += 1;

    decisions.push({
      seq,
      agent: agent.program.id,
      taskId: step.taskId,
      attempt: step.attempt,
      kind: step.kind,
      outcome: result.outcome,
      startVirtualMs,
      endVirtualMs: agent.clock,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    });

    timings.push({
      seq,
      agent: agent.program.id,
      taskId: step.taskId,
      kind: step.kind,
      realMs: Math.round(realMs * 1000) / 1000,
    });
  }

  return {
    decisions,
    timings,
    totalVirtualMs: agents.reduce((max, agent) => Math.max(max, agent.clock), 0),
  };
}

/** Convenience for programs: a step whose only outcome is that it happened. */
export function step(
  kind: StepKind,
  taskId: string,
  attempt: number,
  virtualMs: number,
  run: (startVirtualMs: number) => Promise<StepOutcome>,
): Step {
  return { kind, taskId, attempt, virtualMs, run };
}
