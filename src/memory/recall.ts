/**
 * RECALL — the read path. spec/03-MEMORY-MODEL.md §4.1.
 *
 * One statement, one snapshot, joining semantic similarity against structural
 * outcome history. A vector database cannot run it: it can rank `findings` by
 * distance, but it cannot then join those rows to the episodic record of what
 * happened the last time someone acted on them, and order by both at once.
 *
 * Read-only, so no transaction and no retry helper — there is no write to
 * serialize against. In production this SQL is issued through the CockroachDB
 * Cloud Managed MCP Server under the read-only service account (05-INTERFACES.md
 * §3), which is why the query text is kept verbatim and parameterised: the same
 * statement ships in the Agent Skill.
 */
import { getPool, type Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';

/** §4.1: findings past this cosine distance are noise, not memory. */
export const DEFAULT_MAX_DISTANCE = 0.35;

/** §4.1: how many neighbours the vector index returns before the join. */
export const DEFAULT_CANDIDATES = 40;

/** §4.1: how many survive to the agent's context window. */
export const DEFAULT_K = 8;

export interface RecallInput {
  repoId: string;
  /** Embedding of the agent's query. Titan Text Embeddings V2, 1024 dimensions. */
  embedding: readonly number[];
  k?: number;
  maxDistance?: number;
  candidates?: number;
  /**
   * Which privilege plane to read on. Defaults to the write plane, which is what the CLI
   * and the benchmark use. The hosted demo passes `'demo'` with its session scope, so a
   * visitor's recall is the same query under `cortex_demo`'s row-level security.
   *
   * Note what this is *not*: the agent-facing read path is `cortex_reader` reached with a
   * stock client and the SQL in `skills/cortex-memory/SKILL.md`, which never enters this
   * process at all (V17, V21).
   */
  plane?: Plane;
  /** The demo session scope, when the plane is `demo`. */
  demoSession?: string;
  /** Collects the statements this call executes, for `05` §5's show-SQL panel. */
  recorder?: StatementRecorder;
}

export interface Finding {
  fact: string;
  confidence: number;
  distance: number;
  /** How often work that produced this fact was later reverted. Drives the ordering. */
  timesReverted: number;
  /** When the source intent last closed; null for a finding with no source intent. */
  lastTouched: Date | null;
}

/**
 * Exported so `skills/cortex-memory/SKILL.md` can be pinned against it.
 *
 * `05` §4 requires the skill to ship this query "pinned against `src/memory/recall.ts`
 * rather than retyped, so the filter cannot drift out of it". A test holds the two
 * byte-for-byte. Retyping is how a `repo_id` predicate goes missing, and per V5 a
 * missing filter fails open rather than closed — the planner drops to a full scan and
 * returns another tenant's rows.
 */
export const RECALL_SQL = `
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, contradictions,
         embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
)
SELECT n.fact,
       n.confidence,
       n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at)                                             AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id AND i.repo_id = $2
WHERE n.dist < $4
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT $5`;

/**
 * What the fleet knows about `repoId`, nearest first, reverts first of all.
 *
 * The `WHERE repo_id` is load-bearing, contrary to §2's design note. V5 in
 * docs/verification-log.md measured what the `(repo_id, embedding)` index prefix
 * actually does: supplying the prefix bounds the vector search to one tenant's
 * partition, but *omitting* it does not fail closed — the planner drops to a FULL
 * SCAN and happily returns another repo's rows. The prefix makes single-tenant
 * recall the fast path and makes a forgotten filter visible in the plan. It is not
 * the isolation boundary, so this clause is the boundary and must not be removed.
 *
 * There are *two* such clauses, and §4.1's published SQL has only the first. The
 * `near` CTE scopes the vector search; the `LEFT JOIN` onto `intents` needs its own
 * `i.repo_id`, because `findings.source_intent_id` carries no foreign key and so a
 * finding in repo A can name an intent in repo B. Measured, not reasoned: without
 * the join predicate, repo A's recall counted repo B's revert into its own ordering.
 * No text crosses — the join contributes only `times_reverted` and `last_touched` —
 * but the ordering repo A receives is then computed from a tenant it cannot see, and
 * invariant 5 is that every read carries the filter rather than that the rows happen
 * to line up. Recorded against §4.1 in docs/SPEC-DELTA.md.
 */
export async function recall(input: RecallInput): Promise<Finding[]> {
  const {
    repoId,
    embedding,
    k = DEFAULT_K,
    maxDistance = DEFAULT_MAX_DISTANCE,
    candidates = DEFAULT_CANDIDATES,
  } = input;

  const parameters = [`[${embedding.join(',')}]`, repoId, candidates, maxDistance, k];

  // A read, so no transaction is required — but the demo plane's scope is
  // transaction-local by design (`src/db/retry.ts`), so a scoped recall has to run inside
  // one. Unscoped, the policies would match nothing and the panel would show an empty
  // recall that looked like an honest "nothing known".
  const { rows } =
    input.plane === 'demo'
      ? await withRetry(async (client) => client.query(RECALL_SQL, parameters), {
          plane: 'demo',
          ...(input.demoSession ? { demoSession: input.demoSession } : {}),
          ...(input.recorder ? { recorder: input.recorder } : {}),
        })
      : await getPool(input.plane ?? 'write').query(RECALL_SQL, parameters);

  return rows.map((row) => ({
    fact: row.fact as string,
    confidence: Number(row.confidence),
    distance: Number(row.dist),
    timesReverted: Number(row.times_reverted),
    lastTouched: (row.last_touched as Date | null) ?? null,
  }));
}
