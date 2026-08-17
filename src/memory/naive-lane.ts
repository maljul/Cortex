/**
 * THE CONVENTIONAL STACK — a vector store plus a lock service, run fairly, and **deliberately
 * not** the mechanism this project argues for.
 *
 * ## Read this before changing anything here
 *
 * `03` §8 invariant 1 says: dedupe and claim share **one** transaction, and if a similarity
 * check and a claim insert ever land in different transactions the project's thesis is
 * falsified by its own code. **This file splits them on purpose.** It is not a violation of
 * that invariant; it is `01` §3's falsification test made executable — the arm the mechanism
 * is compared against. Nothing in `src/mcp/`, `src/memory/propose.ts` or any agent-facing path
 * may call it, and `test/naive-lane.test.ts` fails if one does.
 *
 * The named silent break of U21 is this file quietly becoming `propose()`: wrap both halves in
 * one `withRetry` and the naive lane silently *becomes* the cortex lane. Every row would still
 * be valid, every test would still pass, and the demo would show no difference at all. The
 * guard is a test asserting this lane produces **two** `BEGIN` blocks where `propose()` produces
 * one, read off the same `StatementRecorder` that feeds `05` §5's show-SQL panel.
 *
 * ## Why this arm exists at all, and why it is not a strawman
 *
 * `06` §2 defines the benchmark's NAIVE arm as "Arbitration: none. Dedupe: none", and requires
 * it to be "a **fair** representation of what people actually do today... Do not strawman it
 * with something nobody uses." The hosted demo goes further than the benchmark, because a
 * database-company judge will push on exactly this: design §4.2 gives the naive lane **both**
 * of the things `01` §3 says the field actually runs — a vector store it can search, and a lock
 * service it can take. It is a real dedupe against the same rows, and a real all-or-nothing
 * claim through the same unique index.
 *
 * Every SQL statement below is imported from `src/memory/propose.ts` rather than written here.
 * That is the fairness requirement made structural: the two lanes cannot drift into being two
 * different queries and have the difference reported as a coordination result.
 *
 * ## The two things that differ, and they are the whole demo
 *
 * 1. **The transaction boundary.** The dedupe search commits, the agent works, and the claim is
 *    taken later. So the search passed against a snapshot that *was* true — and by the time the
 *    lease is taken, the work it would have prevented is already underway somewhere else.
 *
 * 2. **What the lock locks.** Julian's call, 2026-08-13. This lane claims the **ticket** it is
 *    working on; the cortex lane claims the **resources the work touches**. That is not a
 *    handicap — it is what a lock service is for in the stack people run. Nobody operating a
 *    worktree fleet locks files; they lock jobs, so two agents do not pick up the same ticket.
 *    And that is precisely why isolation does not help: two *different* tickets colliding in one
 *    file is invisible to a job lock, to a worktree, and to a merge. Recorded in
 *    `docs/DECISIONS.md` and `docs/SPEC-DELTA.md` beside the deviation design §4.2 already
 *    creates.
 *
 * What this lane does **not** have is a `findings` tier. `06` §2 gives NAIVE "Consolidation:
 * none", so no agent here is ever handed another agent's outcome. Three of design §3.1's five
 * interlocks live in exactly that gap — the space between dedupe's 0.39 and recall's 0.60.
 */
import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';
import {
  CLAIM_ACQUIRE_SQL,
  CONTESTED_HOLDERS_SQL,
  DEDUPE_CANDIDATE_SQL,
  DEFAULT_DEDUPE_THRESHOLD,
  INTENT_INSERT_SQL,
  toVector,
  type Contested,
} from './propose.js';

export interface NaiveProposeInput {
  repoId: string;
  agentId: string;
  statement: string;
  /**
   * What this lane's lock service locks — the ticket, not the files. See point 2 above.
   *
   * Still recorded on the intent's `resource_keys` as the files the work touches, because the
   * page has to be able to say which files each agent edited in order to attribute a loss. The
   * claim and the record are different things here, which is the deviation.
   */
  lockKeys: readonly string[];
  /** The files this agent's work actually touches. Recorded, never claimed, in this lane. */
  resourceKeys: readonly string[];
  embedding: readonly number[];
  leaseSeconds?: number;
  dedupeThreshold?: number;
  plane?: Plane;
  demoSession?: string;
  recorder?: StatementRecorder;
}

/**
 * What the lock service can answer. **`deduped` is not one of them**, and that is the split
 * expressed in the type: in this lane the dedupe answer came back in an earlier transaction and
 * the claim knows nothing about it.
 */
export type NaiveClaimDecision =
  | { decision: 'granted'; intentId: string; keys: string[]; expiresAt: Date }
  | { decision: 'blocked'; contested: Contested[] };

/** The nearest prior intent, or `null`. Exactly `propose()`'s search, in its own transaction. */
export interface NaiveDuplicate {
  of: string;
  holder: string;
  status: string;
  outcome: unknown;
  distance: number;
}

function planeOptions(input: NaiveProposeInput) {
  return {
    ...(input.plane ? { plane: input.plane } : {}),
    ...(input.demoSession ? { demoSession: input.demoSession } : {}),
    ...(input.recorder ? { recorder: input.recorder } : {}),
  };
}

/**
 * TRANSACTION ONE — the vector store answers "has anyone already said this?"
 *
 * Separate from the claim, and that separation is the point rather than an oversight. It goes
 * through `withRetry` because invariant 6 admits no exception and because the demo scope is
 * transaction-local; what it does not do is stay open while the agent works.
 */
export async function naiveDedupeSearch(
  input: NaiveProposeInput,
): Promise<NaiveDuplicate | null> {
  const threshold = input.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const vector = toVector(input.embedding);

  return withRetry(async (client) => {
    const { rows } = await client.query(DEDUPE_CANDIDATE_SQL, [input.repoId, vector]);
    const nearest = rows[0] as
      | { id: string; agent_id: string; status: string; outcome: unknown; dist: number }
      | undefined;

    if (nearest === undefined || Number(nearest.dist) >= threshold) return null;

    return {
      of: nearest.id,
      holder: nearest.agent_id,
      status: nearest.status,
      outcome: nearest.outcome,
      distance: Number(nearest.dist),
    };
  }, planeOptions(input));
}

/**
 * TRANSACTION TWO — the lock service takes the lease, and records the intent.
 *
 * All-or-nothing on the keys asked for, through the same statement and the same unique index
 * `propose()` uses. A lock service that granted a subset would be a strawman; this one does not.
 */
export async function naiveClaim(input: NaiveProposeInput): Promise<NaiveClaimDecision> {
  const { leaseSeconds = 600 } = input;
  const vector = toVector(input.embedding);
  const keys = [...input.lockKeys];

  return withRetry(async (client) => {
    const { rows: intentRows } = await client.query(INTENT_INSERT_SQL, [
      input.repoId,
      input.agentId,
      input.statement,
      [...input.resourceKeys],
      vector,
      false,
    ]);
    const intentId = (intentRows[0] as { id: string }).id;

    const { rows: acquired } = await client.query(CLAIM_ACQUIRE_SQL, [
      input.repoId,
      intentId,
      input.agentId,
      `${leaseSeconds} seconds`,
      keys,
    ]);

    if (acquired.length < keys.length) {
      const won = new Set(acquired.map((row) => row.resource_key as string));
      const lost = keys.filter((key) => !won.has(key));
      const { rows: holders } = await client.query(CONTESTED_HOLDERS_SQL, [input.repoId, lost]);

      // **No rollback**, and that is this lane rather than a bug. The intent row stays: a
      // conventional fleet that failed to take a lease still recorded that it tried, and the
      // page needs the row to attribute what the agent went on to do. `propose()` rolls the
      // whole thing back because a partial claim there would mean interleaved half-edits;
      // here there is nothing atomic to preserve, because the claim was never in the same
      // transaction as the check that justified it.
      return {
        decision: 'blocked' as const,
        contested: holders.map((row) => ({
          resourceKey: row.resource_key as string,
          holder: row.holder as string,
          intentId: row.intent_id as string,
          expiresAt: row.expires_at as Date,
          // Same statement, same columns, same shape as `propose()`. This lane never
          // surfaces the field, so carrying it changes nothing here — but dropping it
          // would make the two lanes read different rows out of one query, which is the
          // drift `06` §2 forbids.
          holderStatement: (row.holder_statement as string | null) ?? null,
        })),
      };
    }

    return {
      decision: 'granted' as const,
      intentId,
      keys,
      expiresAt: (acquired[0] as { expires_at: Date }).expires_at,
    };
  }, planeOptions(input));
}
