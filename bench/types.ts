/**
 * What a benchmark run produces. spec/06-BENCHMARK-SPEC.md §3, §5, §6.
 *
 * The split between `decisions` and `timings` is the unit's whole point and is not
 * cosmetic. §5 requires the re-run to be reproducible; wall-clock latency measured
 * against a real cluster over a real network is not, and pretending otherwise would
 * be the placeholder-number failure in another costume. So:
 *
 * - `decisions`, `acknowledged`, `finalState` — **deterministic**. Two runs of one arm
 *   at one seed against the same cassettes produce these byte-for-byte.
 *   `test/bench-runner.test.ts` asserts exactly that.
 * - `timings` — **not deterministic**, and labelled so. §7.3 wants variance across at
 *   least three runs rather than one best result, which is a statement about these.
 *
 * Every metric in §3 is derivable from the deterministic half except `claim_p50`,
 * `claim_p95` and `goodput`, which are latency by definition. U13 computes them and
 * reports their spread.
 */
/** §2's two arms. NAIVE is the fair conventional stack, not a strawman. */
export type Arm = 'naive' | 'cortex';

/** A file region an agent reported writing. §3's `conflicting_edits` is computed over these. */
export interface Effect {
  file: string;
  startLine: number;
  endLine: number;
}

export interface TokenSpend {
  input: number;
  output: number;
}

export type StepKind =
  | 'recall'
  | 'propose'
  | 'work'
  | 'close'
  /** NAIVE only: read the shared JSON task file. */
  | 'load'
  /** NAIVE only: write the whole shared JSON task file back. Last write wins. */
  | 'save';

/**
 * One scheduled step and what it decided.
 *
 * Deliberately carries no UUID, no timestamp and no latency: an intent id differs
 * between runs while naming the same work, so a record containing one could never be
 * compared across runs and the determinism assertion would have to weaken to a
 * shape check. Where a holder must be named, it is named by agent and task.
 */
export interface Decision {
  /** Scheduler order. Global across agents, so it pins the interleaving itself. */
  seq: number;
  agent: string;
  taskId: string;
  /** 1 for a first attempt; higher after a `blocked` re-plan. */
  attempt: number;
  kind: StepKind;
  outcome: string;
  startVirtualMs: number;
  endVirtualMs: number;
  detail?: Record<string, unknown>;
}

/**
 * Work an agent believes it completed. §3's `lost_writes` is
 * `acknowledged - finalState`, which is only a real measurement if this list is
 * written by the agent at the moment it acknowledges, never reconstructed afterwards
 * from the state being audited.
 */
export interface Acknowledged {
  taskId: string;
  agent: string;
  result: 'done' | 'abandoned';
  effects: Effect[];
  tokens: TokenSpend;
  startVirtualMs: number;
  endVirtualMs: number;
}

/** Per-step wall-clock, kept apart from the decisions because it does not reproduce. */
export interface StepTiming {
  seq: number;
  agent: string;
  taskId: string;
  kind: StepKind;
  realMs: number;
}

export interface RunRecord {
  arm: Arm;
  seed: number;
  agents: number;
  /** Task ids in assignment order, so a subset run is self-describing. */
  taskIds: string[];
  cassettes: {
    mode: 'replay' | 'record';
    /** Sorted. Both arms must use the same keys — a test asserts it (§5). */
    reasonKeys: string[];
    embedKeys: string[];
    /**
     * Calls that reached Bedrock. A replay run reports zero of each, and that is the
     * only evidence a reader has that the numbers came off the committed cassettes
     * rather than off a live sample nobody can reproduce.
     */
    liveCalls: { embed: number; reason: number };
  };
  decisions: Decision[];
  acknowledged: Acknowledged[];
  /** Task ids present in the arm's shared state when the run ended, sorted. */
  finalState: string[];
  /** Things the run wants the reader to know. Never a number that belongs in §3. */
  notes: string[];
  timings: {
    steps: StepTiming[];
    wallClockMs: number;
    totalVirtualMs: number;
    /**
     * `40001` retries during the run, read from `src/db/retry.ts`'s counter. Lives
     * here, in the half that does not reproduce, because it is a property of how the
     * transactions happened to interleave — and under this harness's serialised
     * scheduler they do not interleave at all, so it is 0 by construction. `06` §3
     * asks for it; `docs/DECISIONS.md` records why the number means what it means.
     */
    serializationRetries: number;
  };
}

/** The half of a run record that must be identical across two runs of one arm. */
export function deterministicPart(record: RunRecord): unknown {
  const { arm, seed, agents, taskIds, decisions, acknowledged, finalState } = record;
  return {
    arm,
    seed,
    agents,
    taskIds,
    decisions,
    acknowledged,
    finalState,
    cassettes: { reasonKeys: record.cassettes.reasonKeys, embedKeys: record.cassettes.embedKeys },
  };
}
