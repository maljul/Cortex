/**
 * What both arms have in common. spec/06-BENCHMARK-SPEC.md §2, §5.
 *
 * §5: "Both arms consume the **same cassettes**. Any difference in results is
 * therefore attributable to the coordination layer and nothing else." That sentence
 * is the reason this file exists: the embedder, the reasoner, the task assignment and
 * every step duration are built here, once, and handed to whichever arm is running.
 * If an arm could compute its own work durations or its own task order, the claim
 * above would be an assertion rather than a property.
 */
import { contentHash, Embedder } from '../../src/embed/titan.js';
import type { CassetteStore } from '../cassettes.js';
import { Reasoner, type ReasonResult } from '../reason.js';
import { spanMs, shuffled } from '../rng.js';
import type { BenchTask } from '../tasks.js';
import type { Acknowledged, Arm, Effect, TokenSpend } from '../types.js';

export type { Arm };

/** How many times a blocked agent re-plans before giving the task up. */
export const MAX_ATTEMPTS = 3;

/** §5's simulated clock offset: agents do not all start on the same instant. */
export const AGENT_START_STEP_MS = 120;

export interface AssignedAgent {
  id: string;
  index: number;
  queue: BenchTask[];
}

/**
 * Deals the tasks across the fleet: one seeded shuffle, then round-robin.
 *
 * Identical in both arms, which is what makes them comparable. Note the assignment is
 * *not* taken from the shared task file — in the NAIVE arm that file is the thing
 * being shown to lose writes, and deriving the workload from it would let a lost write
 * silently change which tasks each arm attempted.
 */
export function assign(
  tasks: readonly BenchTask[],
  agentCount: number,
  seed: number,
): AssignedAgent[] {
  if (agentCount < 1) throw new Error('a fleet needs at least one agent');

  const order = shuffled(tasks, seed);
  return Array.from({ length: agentCount }, (_unused, index) => ({
    id: `agent-${index + 1}`,
    index,
    queue: order.filter((_task, position) => position % agentCount === index),
  }));
}

/** The tasks in the order they were dealt, for the run record. */
export function assignedOrder(agents: readonly AssignedAgent[]): string[] {
  return agents.flatMap((agent) => agent.queue.map((task) => task.id));
}

export interface BenchContextOptions {
  arm: Arm;
  seed: number;
  store: CassetteStore;
  tasks: readonly BenchTask[];
}

export class BenchContext {
  readonly arm: Arm;
  readonly seed: number;
  readonly store: CassetteStore;
  readonly tasks: readonly BenchTask[];
  readonly acknowledged: Acknowledged[] = [];
  readonly notes: string[] = [];

  private readonly embedder: Embedder;
  private readonly reasoner: Reasoner;

  constructor(options: BenchContextOptions) {
    this.arm = options.arm;
    this.seed = options.seed;
    this.store = options.store;
    this.tasks = options.tasks;
    this.embedder = new Embedder({ cache: options.store.embeddingCache() });
    this.reasoner = new Reasoner(options.store);
  }

  /** Calls that reached Bedrock. A replay run must end with both at zero. */
  get invocations(): { embed: number; reason: number } {
    return { embed: this.embedder.stats.invocations, reason: this.reasoner.invocations };
  }

  async embed(text: string): Promise<number[]> {
    const vector = await this.embedder.embed(text);
    // Labels the cassette with the text it came from. No-op outside record mode.
    this.store.labelEmbedding(
      contentHash(text, this.embedder.model, this.embedder.dimensions),
      text,
    );
    return vector;
  }

  plan(task: BenchTask): Promise<ReasonResult> {
    return this.reasoner.plan(task);
  }

  acknowledge(entry: Acknowledged): void {
    this.acknowledged.push(entry);
  }

  // --- step durations -------------------------------------------------------
  //
  // All four are hashes of the step's identity, never draws from a stream, so a task
  // takes exactly as long in both arms. See bench/rng.ts for why that matters.

  /** Charged to the retry, so a blocked agent goes away and comes back (§5, §3). */
  recallMs(task: BenchTask, attempt: number): number {
    const backoff = attempt > 1 ? spanMs(this.seed, ['backoff', task.id, attempt], 200, 600) : 0;
    return spanMs(this.seed, ['recall', task.id], 30, 90) + backoff;
  }

  arbitrateMs(task: BenchTask, attempt: number, kind: string): number {
    return spanMs(this.seed, [kind, task.id, attempt], 20, 60);
  }

  /** The one duration that must be arm-independent: it is "the same work". */
  workMs(task: BenchTask): number {
    return spanMs(this.seed, ['work', task.id], 400, 1400);
  }
}

/**
 * `03` §4.1's noise floor, reused by the NAIVE arm's local vector store.
 *
 * **Re-exported from the mechanism rather than written as a second literal, and that is
 * load-bearing.** The CORTEX arm calls `recall()` without a `maxDistance`, so it uses
 * `DEFAULT_MAX_DISTANCE`; the NAIVE arm filters its own store with this. While these were two
 * independent literals, moving one and forgetting the other would have given one arm a wider
 * memory than the other and called the difference a coordination result — `06` §3's
 * circularity arriving by accident instead of by intent. Found on 2026-08-12 while changing
 * §4.1's constant, before the change shipped. Do not restore a literal here.
 */
export { DEFAULT_MAX_DISTANCE as RECALL_MAX_DISTANCE } from '../../src/memory/recall.js';

/** Cosine distance, matching the `<=>` operator the CORTEX arm's index is built for. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return 1 - dot / (Math.hypot(...a) * Math.hypot(...b));
}

export interface WorkOutput {
  effects: Effect[];
  note: string;
  tokens: TokenSpend;
}

/** Both arms report work the same way; only where the report is stored differs. */
export function toAcknowledged(
  task: BenchTask,
  agent: string,
  output: WorkOutput,
  window: { startVirtualMs: number; endVirtualMs: number },
): Acknowledged {
  return {
    taskId: task.id,
    agent,
    result: task.kind === 'abandoned' ? 'abandoned' : 'done',
    effects: output.effects,
    tokens: output.tokens,
    startVirtualMs: window.startVirtualMs,
    endVirtualMs: window.endVirtualMs,
  };
}
