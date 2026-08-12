/**
 * CONSOLIDATE — episodic to semantic, off the critical path.
 * spec/03-MEMORY-MODEL.md §4.4, spec/04-ARCHITECTURE.md flow D.
 *
 * A closed intent becomes a durable finding: the outcome is embedded, and semantic memory
 * either gains a row or gains confidence in one it already had. That second branch is the
 * whole point — §4.4 calls it "the mechanism that makes the memory improve over time
 * rather than merely accumulate", and `07` §3 makes it beat 4 of the demo.
 *
 * **Off the critical path, and that is a design constraint rather than an excuse.** No
 * agent waits for this. It is driven by the changefeed (`infra/lambda/changefeed.ts`), so
 * a consolidation that is slow, retried, or missed entirely costs the fleet nothing:
 * agents recall what has been consolidated so far, and `04` §6 already says a stalled
 * changefeed shows a staleness badge rather than blocking anybody.
 *
 * **One transaction, for the ordinary reason.** The candidate search and the write it
 * decides on run on the same client inside `withRetry`. Split across two round trips they
 * would race two consolidations of the same fact into two findings — the exact
 * accumulation this function exists to prevent — and invariant 6 admits no unwrapped
 * write in any case.
 */
import type { Plane } from '../db/pool.js';
import { withRetry } from '../db/retry.js';

/**
 * Cosine distance below which an outcome is treated as evidence for a finding that
 * already exists rather than as a new one. **0.20, from `03` §4.4 verbatim.**
 *
 * Unlike the dedupe threshold this one was given by the spec rather than swept, and it is
 * deliberately much tighter: `DEFAULT_DEDUPE_THRESHOLD` is 0.39 and decides whether two
 * *intents* are the same work, where a false positive costs one skipped task. Here a
 * false positive silently merges two different facts and books the merge as corroborated
 * confidence, which is a lie semantic memory then repeats to every agent that recalls it.
 * Tighter is the right direction for the more expensive mistake.
 */
export const CONSOLIDATION_DISTANCE = 0.2;

/** How much one corroboration raises confidence, per §4.4. Capped at 1.0 by `least`. */
export const CONFIDENCE_STEP = 0.1;

/**
 * The nearest finding in **this repository**, by cosine distance.
 *
 * `WHERE repo_id = $1` is invariant 5 and is not decoration on a vector query — V5
 * measured a vector query without it falling back to a full scan and returning another
 * repository's rows, because the index prefix does not isolate tenants. Losing it here
 * would reinforce one repository's finding on another's evidence, which is worse than a
 * leak: the corrupted row keeps a confidence score that looks earned.
 */
export const CONSOLIDATE_CANDIDATE_SQL = `
  SELECT id, embedding <=> $2 AS distance
    FROM findings
   WHERE repo_id = $1
   ORDER BY embedding <=> $2
   LIMIT 1
`;

const REINFORCE_SQL = `
  UPDATE findings
     SET corroborations    = corroborations + 1,
         confidence        = least(1.0, confidence + $3),
         last_confirmed_at = now()
   WHERE id = $2 AND repo_id = $1
  RETURNING confidence, corroborations
`;

const INSERT_SQL = `
  INSERT INTO findings (repo_id, fact, embedding, source_intent_id)
  VALUES ($1, $2, $3, $4)
  RETURNING id
`;

export interface ConsolidateInput {
  repoId: string;
  /** The outcome, in the words a later agent will read on recall. */
  fact: string;
  embedding: readonly number[];
  sourceIntentId?: string;
  /** Which privilege plane to write on. The hosted demo consolidates as `cortex_demo`. */
  plane?: Plane;
  /** The demo session scope, when the plane is `demo`. */
  demoSession?: string;
  distanceThreshold?: number;
}

export type ConsolidateResult =
  | { action: 'inserted'; findingId: string }
  | {
      action: 'reinforced';
      findingId: string;
      distance: number;
      confidence: number;
      corroborations: number;
    };

function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

/** A closed `intents` row, as the changefeed delivers it. */
export interface ClosedIntentRow {
  id?: unknown;
  repo_id?: unknown;
  statement?: unknown;
  status?: unknown;
  outcome?: unknown;
}

/**
 * The sentence a later agent will read on recall, derived from a closed intent.
 *
 * The agent's own `notes` win when there are any: `03` §4.4 says to embed *the outcome*,
 * and an agent that wrote "the 409 retry is in the client, not the server" has said
 * something a restatement of its task never will. Without notes the fact is the statement
 * plus what happened to it, which is thin but true — and "thin but true" is the only
 * acceptable direction here, because this text becomes semantic memory that other agents
 * act on.
 *
 * A `reverted` outcome consolidates like any other. It is not a failure to be discarded:
 * `recall` orders findings by `times_reverted` **first**, ahead of distance, so a fact
 * whose intent was reverted is the single most valuable thing the next agent can be
 * handed. It reaches that join through `source_intent_id`, which is why the caller passes
 * the intent id rather than dropping it.
 */
export function factFromClosedIntent(row: ClosedIntentRow): string | null {
  const statement = typeof row.statement === 'string' ? row.statement.trim() : '';
  if (statement === '') return null;

  const outcome = (row.outcome ?? null) as { notes?: unknown; result?: unknown } | null;
  const notes = typeof outcome?.notes === 'string' ? outcome.notes.trim() : '';
  if (notes !== '') return notes;

  return restatement(row);
}

/** `<statement> — <result>`: what happened, in the vocabulary of the work it happened to. */
function restatement(row: ClosedIntentRow): string {
  const statement = typeof row.statement === 'string' ? row.statement.trim() : '';
  const outcome = (row.outcome ?? null) as { result?: unknown } | null;
  const result = typeof outcome?.result === 'string' ? outcome.result : 'done';
  return `${statement} — ${result}`;
}

/**
 * The text a finding is **found by**, which is not always the text it **says**.
 *
 * For nearly everything these are the same string and `consolidate()` has always embedded
 * the fact itself. Abandonment is where they come apart, and the gap was measured against
 * live Titan on 2026-08-12 rather than reasoned about:
 *
 * ```
 *                                              T1        T2        T3
 *   the abandonReason alone   (the obstacle)   0.6725    0.7246    0.7222
 *   "<statement> — abandoned" (the work)       0.4698    0.4768    0.4899
 *   both in one sentence                       0.6090    0.6053    0.6022
 * ```
 *
 * T1–T3 are wordings of the task that the warning exists to save. Recall's cutoff is 0.60,
 * so **only the middle row is ever retrieved.** The cause is plain once seen: an abandonment
 * note describes the obstacle — "the provider's v3 API is not available on this account" —
 * while the agent who needs it is describing the work. Titan has no reason to place those
 * near each other, and it does not. Writing both into one sentence does not rescue it: the
 * obstacle clause pulls the vector away faster than naming the work pulls it back, and it
 * lands two hundredths outside the cutoff.
 *
 * Left alone, this ships a genuinely bad property: **the agent that explains itself
 * carefully produces a finding nobody can retrieve, and the agent that says nothing produces
 * one that works.** So an abandoned intent is embedded on its restatement and stores its
 * reason — found by the work it concerns, read as the reason it failed.
 *
 * **Scoped to abandonment on purpose.** A `done` intent's notes share vocabulary with its
 * own work, and V28 measured the demo's seeded finding at 0.3801 from the task that recalls
 * it on exactly that basis. Widening this to every closed intent would move a number beat 1
 * depends on, and it would need the whole recall corpus re-measured first.
 */
export function retrievalKeyFromClosedIntent(row: ClosedIntentRow): string | null {
  const fact = factFromClosedIntent(row);
  if (fact === null) return null;
  return row.status === 'abandoned' ? restatement(row) : fact;
}

export interface ConsolidateIntentOptions {
  /** Embeds the fact. Injected so the caller owns the Bedrock dependency, not this module. */
  embed: (text: string) => Promise<number[]>;
  plane?: Plane;
  demoSession?: string;
}

/**
 * Which closed states leave semantic memory behind.
 *
 * **`03` §4.4 says "rows transitioning to `done`" and this is `done` *and* `abandoned`.**
 * Julian's call on 2026-08-12 (U21); deviation recorded in `docs/SPEC-DELTA.md`, reasoning
 * in `docs/DECISIONS.md`.
 *
 * The argument is that §4.4's line groups four statuses that do not belong together.
 * `proposed` and `in_flight` are unfinished and have no outcome to embed; `deduped` is work
 * that deliberately never happened. An **abandoned** intent is none of those — it is a
 * finished investigation whose result is a fact, and it is the single most expensive thing
 * a fleet learns, because an agent spent tokens discovering it. "The provider's v3 API is
 * not available on this account" is exactly what the next agent needs and exactly what it
 * could not get: consolidation ignored it, the changefeed sink ignored it, and
 * `findDuplicate`'s candidate set excludes `abandoned` too. The fleet paid for the
 * knowledge and then threw it away, keeping only its cheap successes.
 *
 * **The risk this takes on, stated rather than buried.** An agent may abandon for a
 * transient reason — out of time, wrong branch — and that becomes a durable finding saying
 * the work could not be done. Three things bound it: the fact is the agent's own `notes`
 * rather than an inference; a finding enters at confidence 0.5 like any other and is
 * corroborated or contradicted by what happens next; and `recall()` returns it as one line
 * of context, never as an instruction. A recall false positive costs attention, which is
 * the ordering argument `docs/DECISIONS.md` already settled for the recall threshold.
 *
 * **Deliberately not extended to dedupe.** `findDuplicate` still excludes `abandoned`, so a
 * later agent is *informed* that something was given up and is not *stopped* from trying.
 * "Someone gave up" is not evidence the work is impossible, and blocking on it would turn a
 * hint into a veto.
 */
const CONSOLIDATES = new Set(['done', 'abandoned']);

/**
 * Flow D in one call: a closed intent arrives from the changefeed and becomes semantic
 * memory. Returns `null` for anything that is not a consolidatable transition, which is
 * most of what a changefeed on `intents` emits.
 *
 * The filtering is here rather than in the sink handler because "which row transitions
 * deserve a finding" is a memory-model question. See `CONSOLIDATES` for which, and why it
 * is not the set `03` §4.4 names.
 */
export async function consolidateClosedIntent(
  row: ClosedIntentRow,
  options: ConsolidateIntentOptions,
): Promise<ConsolidateResult | null> {
  if (typeof row.status !== 'string' || !CONSOLIDATES.has(row.status)) return null;

  const repoId = typeof row.repo_id === 'string' ? row.repo_id : null;
  const fact = factFromClosedIntent(row);
  // Not `embed(fact)`. See `retrievalKeyFromClosedIntent` — for an abandoned intent the two
  // are different strings, and embedding the fact makes the finding unretrievable by the
  // agent it exists to save. Measured, not reasoned about.
  const key = retrievalKeyFromClosedIntent(row);
  if (!repoId || !fact || !key) return null;

  return consolidate({
    repoId,
    fact,
    embedding: await options.embed(key),
    ...(typeof row.id === 'string' ? { sourceIntentId: row.id } : {}),
    ...(options.plane ? { plane: options.plane } : {}),
    ...(options.demoSession ? { demoSession: options.demoSession } : {}),
  });
}

export async function consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
  const threshold = input.distanceThreshold ?? CONSOLIDATION_DISTANCE;
  const embedding = toVectorLiteral(input.embedding);

  return withRetry(
    async (client) => {
      const candidate = await client.query<{ id: string; distance: string }>(
        CONSOLIDATE_CANDIDATE_SQL,
        [input.repoId, embedding],
      );

      const nearest = candidate.rows[0];
      const distance = nearest ? Number(nearest.distance) : Number.POSITIVE_INFINITY;

      if (nearest && distance < threshold) {
        const { rows } = await client.query<{ confidence: string; corroborations: string }>(
          REINFORCE_SQL,
          [input.repoId, nearest.id, CONFIDENCE_STEP],
        );
        const updated = rows[0];
        if (!updated) {
          // The candidate was visible to the SELECT and not to the UPDATE, which under
          // one snapshot means the repository predicate disagreed between them. Refusing
          // is right: silently inserting instead would hide a scoping bug as a duplicate.
          throw new Error(`finding ${nearest.id} vanished between candidate and reinforce`);
        }

        return {
          action: 'reinforced' as const,
          findingId: nearest.id,
          distance,
          confidence: Number(updated.confidence),
          corroborations: Number(updated.corroborations),
        };
      }

      const { rows } = await client.query<{ id: string }>(INSERT_SQL, [
        input.repoId,
        input.fact,
        embedding,
        input.sourceIntentId ?? null,
      ]);

      return { action: 'inserted' as const, findingId: rows[0]!.id };
    },
    {
      ...(input.plane ? { plane: input.plane } : {}),
      ...(input.demoSession ? { demoSession: input.demoSession } : {}),
    },
  );
}
