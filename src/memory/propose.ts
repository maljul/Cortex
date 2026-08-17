/**
 * DEDUPE + CLAIM — the arbitration transaction. spec/03-MEMORY-MODEL.md §4.2.
 *
 * One transaction, one snapshot. Dedupe and claim are not split into two round
 * trips: if they were, the project's thesis would be falsified by its own code
 * (§4.2 invariant 2). Everything here runs inside `withRetry`, so a SERIALIZABLE
 * conflict is retried rather than surfaced.
 */
import type { PoolClient } from 'pg';

import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';
import { expandKeys, type GlobResolver } from './keys.js';

/**
 * Cosine distance below which a proposed intent is treated as a duplicate of one
 * already known. `03` §4.2 marked this `[OPEN]` and empirical; it was swept and closed
 * at **0.39** on 2026-08-10.
 *
 * The sweep is `bench/results/*\/threshold-sweep.md`, and the corpus separates cleanly:
 * the worst genuinely-duplicate pair sits at 0.3630 and the closest combination that is
 * *not* a duplicate at 0.4293, so any value in that band classifies all thirty tasks
 * perfectly. 0.39 is near the middle of it.
 *
 * **It is deliberately not 0.40**, which is `JUDGE_THRESHOLD` in `bench/metrics.ts`.
 * The judge scores the benchmark that justifies this constant; carrying the same number
 * in both places would look like the mechanism and its scorer were tuned together, and
 * `06` §3 exists to prevent exactly that. They were chosen independently and the values
 * say so.
 *
 * The previous value, 0.28, caught 4 of the corpus's 6 declared pairs with no false
 * positives — precision was never the problem, recall was.
 */
export const DEFAULT_DEDUPE_THRESHOLD = 0.39;

export const EMBEDDING_DIMENSIONS = 1024;

export interface ProposeInput {
  repoId: string;
  agentId: string;
  statement: string;
  resourceKeys: readonly string[];
  embedding: readonly number[];
  leaseSeconds?: number;
  dedupeThreshold?: number;
  /**
   * `04` §5 rung 2: this vector is a deterministic local hash, not a Bedrock embedding,
   * because Bedrock was throttled or unavailable. Two things follow and they are one flag
   * on purpose — **dedupe is skipped for this intent, and the row is marked.**
   *
   * Deliberately not a general `skipDedupe`. Skipping dedupe is skipping the mechanism this
   * project exists to argue for, so the only way to ask for it is to simultaneously assert
   * that the embedding is untrustworthy and record that assertion in the database, where
   * `findDuplicate` and the panel can both see it. A boolean meaning "turn arbitration's
   * memory half off" would be one careless default away from falsifying the thesis.
   *
   * §8 invariant 1 is untouched and the distinction is worth being precise about: the
   * invariant is that a similarity check and a claim insert never land in *different*
   * transactions. Not performing a check is not splitting one. What falsifies the thesis is
   * a dedupe that happened somewhere else, not a dedupe that honestly did not happen.
   */
  degradedEmbedding?: boolean;
  /** Omit for claims with no `glob:` keys; a glob without a resolver is an error. */
  resolveGlob?: GlobResolver;
  /**
   * Which privilege plane to arbitrate on. Defaults to the write plane — the CLI and the
   * MCP tools. The hosted demo passes `'demo'` with its session scope, so a visitor's
   * arbitration runs through **this same transaction** under `cortex_demo`'s row-level
   * security rather than through a second, demo-shaped implementation. A separate one
   * would mean the demo demonstrating something other than the mechanism.
   */
  plane?: Plane;
  /** The demo session scope, when the plane is `demo`. */
  demoSession?: string;
  /** Collects the statements this call executes, for `05` §5's show-SQL panel. */
  recorder?: StatementRecorder;
}

export interface Contested {
  resourceKey: string;
  holder: string;
  intentId: string;
  expiresAt: Date;
  /**
   * What the holder said it was doing. Null only if the intent row is unreachable — see
   * `CONTESTED_HOLDERS_SQL`, which left-joins rather than dropping the contested key.
   */
  holderStatement: string | null;
}

export type ProposeResult =
  | { decision: 'granted'; intentId: string; keys: string[]; expiresAt: Date }
  | {
      decision: 'deduped';
      /** This proposal's own row, recorded as `status = 'deduped'`. See below. */
      intentId: string;
      of: string;
      holder: string;
      status: string;
      outcome: unknown;
      distance: number;
    }
  | { decision: 'blocked'; contested: Contested[] };

/**
 * Carries a decision out through `withRetry`'s rollback path.
 *
 * `blocked` is an outcome, not a failure, but it must roll back: a partial claim set
 * must leave none (§4.2 invariant 1). Throwing is how the transaction is abandoned
 * while the answer survives; `withRetry` rethrows anything that is not a 40001.
 *
 * **`deduped` no longer travels this way.** It used to, and the comment here used to read
 * "a deduped intent leaves no row" — which was true, and was the bug. `03` §2 declares
 * `intents.deduped_of` and a `'deduped'` status; §4.2 says ROLLBACK; the two contradict
 * each other and §4.2 won for months, so the column was written by nothing and the
 * project's headline claim — duplicate work avoided — was not auditable from the database
 * at all, against `07` §1. A dedupe now commits its row and returns normally. See
 * `DEDUPED_INTENT_INSERT_SQL`. Recorded in docs/SPEC-DELTA.md.
 */
class Decided extends Error {
  constructor(readonly result: ProposeResult) {
    super('arbitration decided');
  }
}

/**
 * VECTOR literals go over the wire as '[a,b,c]'.
 *
 * Exported so `src/memory/duplicates.ts` measures distances through the same formatting
 * and the same dimension check this transaction uses. A second copy would be a second
 * place for the width to drift, and V-5-era experience here is that a width mismatch
 * fails as a wrong answer rather than as an error.
 */
export function toVector(embedding: readonly number[]): string {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding must have ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
    );
  }
  return `[${embedding.join(',')}]`;
}

/**
 * The similarity search dedupe runs, as one literal.
 *
 * `NOT embedding_degraded` is `04` §5 rung 2's other half, and it is the half that is easy to
 * leave out. A row written while Bedrock was down carries a hash, which sits at an arbitrary
 * distance from every real embedding — so leaving it in the candidate set would not merely fail
 * to help, it would corrupt every dedupe decision taken after it, indefinitely, long after
 * Bedrock came back. Degrading has to be temporary in its effects as well as in its cause.
 *
 * **Exported because the demo's naive lane issues this exact statement** (`src/memory/
 * naive-lane.ts`), in a transaction of its own. `06` §2 forbids strawmanning that arm and
 * design §4.2 is explicit that the two lanes differ in the transaction boundary and nothing
 * else — so the search cannot be a second literal, or the comparison would eventually be
 * between two different queries and the difference would be reported as a coordination result.
 * Same reasoning as `RECALL_SQL` being pinned to the published skill.
 */
export const DEDUPE_CANDIDATE_SQL = `SELECT id, agent_id, status, outcome, embedding <=> $2 AS dist
       FROM intents
      WHERE repo_id = $1
        AND status IN ('in_flight', 'done')
        AND NOT embedding_degraded
      ORDER BY embedding <=> $2
      LIMIT 5`;

/**
 * The row a *deduped* proposal leaves behind, so that avoided work is a fact in the
 * database rather than only a return value.
 *
 * **This does not split the arbitration transaction.** It runs on the same snapshot as the
 * search that justified it — same client, same `withRetry` callback — and acquires no
 * claims, which is invariant 2's all-or-nothing at its zero end. Invariant 1 is about a
 * similarity check and a claim insert landing in *different* transactions; committing the
 * search's own conclusion beside it is the opposite of that. Writing this row from a
 * second transaction after a rollback is what would have been indefensible, because two
 * transactions around one decision is precisely what `naive-lane.ts` exists to be the
 * counterexample to.
 *
 * `status = 'deduped'` is terminal by construction and nothing had to be added to make it
 * so: `DEDUPE_CANDIDATE_SQL` admits only `in_flight` and `done`, so these rows can never
 * become dedupe candidates; `consolidate.ts`'s CONSOLIDATES admits only `done` and
 * `abandoned`, so they never produce a finding; and `close.ts` updates only rows that are
 * `in_flight`, so they cannot be closed. Three existing filters, none of them widened.
 *
 * `embedding_degraded` is omitted because it defaults false and this path is unreachable
 * when the embedding is degraded — `04` §5 rung 2 skips dedupe entirely rather than running
 * it at a threshold of zero.
 */
export const DEDUPED_INTENT_INSERT_SQL = `INSERT INTO intents
           (repo_id, agent_id, statement, resource_keys, embedding, status, deduped_of)
         VALUES ($1, $2, $3, $4::STRING[], $5, 'deduped', $6)
         RETURNING id`;

/** The intent row an agent's proposal creates. Shared with the naive lane; see above. */
export const INTENT_INSERT_SQL = `INSERT INTO intents
           (repo_id, agent_id, statement, resource_keys, embedding, status, embedding_degraded)
         VALUES ($1, $2, $3, $4::STRING[], $5, 'in_flight', $6)
         RETURNING id`;

/**
 * Claim acquisition. Shared with the naive lane, which is what makes that lane's lock service
 * a real one rather than a weakened copy — same table, same unique index, same all-or-nothing.
 *
 * ON CONFLICT DO UPDATE, not DO NOTHING as spec §4.2 writes it.
 *
 * V4 in docs/verification-log.md measured the TTL sweep landing between 62 and 221 seconds
 * behind expires_at. DO NOTHING treats a lapsed-but-unswept claim as held, so a dead agent's
 * key stays unacquirable for up to a sweep interval past its lease — which contradicts §1 ("a
 * dead agent releases nothing by hand") and §5 ("claim acquisition MUST NOT wait"). The guarded
 * UPDATE takes over a claim only once it has genuinely expired; a live claim fails the WHERE,
 * is not returned, and still blocks.
 */
export const CLAIM_ACQUIRE_SQL = `INSERT INTO claims (repo_id, resource_key, intent_id, holder, expires_at)
         SELECT $1, k, $2, $3, now() + $4::INTERVAL
           FROM unnest($5::STRING[]) AS k
         ON CONFLICT (repo_id, resource_key) DO UPDATE
            SET intent_id  = excluded.intent_id,
                holder     = excluded.holder,
                acquired_at = now(),
                expires_at = excluded.expires_at
          WHERE claims.expires_at <= now()
         RETURNING resource_key, expires_at`;

/**
 * Who holds the keys an agent could not get. Invariant 3, and shared with the naive lane.
 *
 * The join carries the holder's **statement**, not just its id. Invariant 3 is "a blocked agent
 * learns the holder and its intent, so it can re-plan rather than poll" — and a bare UUID is not
 * an intent an agent can re-plan around. It cannot dereference one either: reads go through
 * `cortex_reader` (`04` §2), so an id returned on the write plane names a row this agent has no
 * tool here to fetch. The skill promised the statement before this query returned it; a real
 * fleet run in V63 is what caught the gap.
 *
 * **LEFT, not INNER.** An inner join drops a contested key whose intent row cannot be seen, which
 * turns "someone holds this" into "nothing holds this" — invariant 3 failing open, silently, in
 * exactly the case it exists for. A null statement is a worse answer than a full one and a far
 * better one than a missing row.
 *
 * Invariant 5 holds on both sides: `c.repo_id = $1` filters the claims, and the join predicate
 * pins the intent to the same repo rather than trusting the id to be unique across tenants.
 */
export const CONTESTED_HOLDERS_SQL = `SELECT c.resource_key, c.holder, c.intent_id, c.expires_at,
             i.statement AS holder_statement
       FROM claims c
       LEFT JOIN intents i ON i.repo_id = c.repo_id AND i.id = c.intent_id
      WHERE c.repo_id = $1 AND c.resource_key = ANY($2::STRING[])
      ORDER BY c.resource_key`;

/** What the search found, before this proposal's own row exists to be named alongside it. */
type DuplicateOf = Omit<Extract<ProposeResult, { decision: 'deduped' }>, 'decision' | 'intentId'>;

async function findDuplicate(
  client: PoolClient,
  repoId: string,
  vector: string,
  threshold: number,
): Promise<DuplicateOf | null> {
  const { rows } = await client.query(DEDUPE_CANDIDATE_SQL, [repoId, vector]);

  const nearest = rows[0] as
    | { id: string; agent_id: string; status: string; outcome: unknown; dist: number }
    | undefined;

  if (nearest === undefined || Number(nearest.dist) >= threshold) return null;

  // §4.2 invariant 4: a deduped agent receives the prior outcome, not a rejection.
  // That is what turns arbitration into memory.
  return {
    of: nearest.id,
    holder: nearest.agent_id,
    status: nearest.status,
    outcome: nearest.outcome,
    distance: Number(nearest.dist),
  };
}

async function contestedHolders(
  client: PoolClient,
  repoId: string,
  keys: readonly string[],
): Promise<Contested[]> {
  const { rows } = await client.query(CONTESTED_HOLDERS_SQL, [repoId, keys]);

  return rows.map((row) => ({
    resourceKey: row.resource_key as string,
    holder: row.holder as string,
    intentId: row.intent_id as string,
    expiresAt: row.expires_at as Date,
    holderStatement: (row.holder_statement as string | null) ?? null,
  }));
}

/**
 * Runs the arbitration transaction and returns what the agent is allowed to do.
 *
 * Never throws on contention — `blocked` and `deduped` are ordinary results.
 * §5: claim acquisition must not wait on a contested key, so this loses fast and
 * hands back enough information to re-plan.
 */
export async function propose(input: ProposeInput): Promise<ProposeResult> {
  const {
    repoId,
    agentId,
    statement,
    resourceKeys,
    embedding,
    leaseSeconds = 600,
    dedupeThreshold = DEFAULT_DEDUPE_THRESHOLD,
    degradedEmbedding = false,
    resolveGlob = () => {
      throw new Error('a glob: key was requested but no resolveGlob was supplied');
    },
  } = input;

  const planeOptions = {
    ...(input.plane ? { plane: input.plane } : {}),
    ...(input.demoSession ? { demoSession: input.demoSession } : {}),
    ...(input.recorder ? { recorder: input.recorder } : {}),
  };

  const keys = await expandKeys(resourceKeys, resolveGlob);
  const vector = toVector(embedding);

  try {
    return await withRetry(async (client) => {
      // Not a threshold of zero. That would leave the search in the transcript, telling a
      // judge reading `05` §5's show-SQL panel that a dedupe happened when §5's rung 2 says
      // it was skipped — the panel exists to be the one thing that cannot lie.
      if (!degradedEmbedding) {
        const duplicate = await findDuplicate(client, repoId, vector, dedupeThreshold);
        if (duplicate) {
          // Commit, do not throw. The proposal is recorded as having happened and having
          // been answered by prior work — no claims, so nothing is held. Returning here
          // rather than falling through is what keeps this on one snapshot.
          const { rows } = await client.query(DEDUPED_INTENT_INSERT_SQL, [
            repoId,
            agentId,
            statement,
            keys,
            vector,
            duplicate.of,
          ]);

          return {
            decision: 'deduped' as const,
            intentId: (rows[0] as { id: string }).id,
            ...duplicate,
          };
        }
      }

      const { rows: intentRows } = await client.query(INTENT_INSERT_SQL, [
        repoId,
        agentId,
        statement,
        keys,
        vector,
        degradedEmbedding,
      ]);
      const intentId = (intentRows[0] as { id: string }).id;

      const { rows: acquired } = await client.query(CLAIM_ACQUIRE_SQL, [
        repoId,
        intentId,
        agentId,
        `${leaseSeconds} seconds`,
        keys,
      ]);

      // §4.2 invariant 1: all or nothing. A strict subset is worse than losing,
      // because partial ownership produces interleaved half-edits.
      if (acquired.length < keys.length) {
        const won = new Set(acquired.map((row) => row.resource_key as string));
        const lost = keys.filter((key) => !won.has(key));
        // Read the holders before rolling back — §4.2 invariant 3: a blocked agent
        // must learn who holds the key, or it can only poll.
        throw new Decided({
          decision: 'blocked',
          contested: await contestedHolders(client, repoId, lost),
        });
      }

      return {
        decision: 'granted' as const,
        intentId,
        keys,
        expiresAt: (acquired[0] as { expires_at: Date }).expires_at,
      };
    }, planeOptions);
  } catch (error) {
    if (error instanceof Decided) return error.result;
    throw error;
  }
}
