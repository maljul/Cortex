/**
 * The episodic record, read back. spec/03-MEMORY-MODEL.md §4.1, §8 invariant 5.
 *
 * `recall` answers "what does the fleet know", which is the semantic tier. This
 * answers "what did the fleet actually finish", which is the episodic one — and it
 * exists because `06` §3 defines `lost_writes` as the diff between the effects agents
 * acknowledged and the final repository state. Something has to be able to read that
 * final state, and SQL lives in `src/memory/` and `src/db/` only.
 *
 * Read-only, so no transaction and no `withRetry`: there is no write to serialize
 * against. The `WHERE repo_id` is invariant 5 and is the only thing separating this
 * from a cross-tenant dump of every agent's work.
 */
import { getPool } from '../db/pool.js';

/** The two terminal statuses `close` writes (§4.3). */
export type TerminalStatus = 'done' | 'abandoned';

export interface CompletedIntent {
  statement: string;
  status: TerminalStatus;
  tokensSpent: number;
  /** What the agent reported: `{result, files_changed?, notes?}`. */
  outcome: unknown;
}

export interface CompletedIntentsInput {
  repoId: string;
}

/**
 * Every closed intent in one repository, ordered by statement.
 *
 * Ordered by statement rather than by `closed_at` deliberately: two intents can close
 * inside the same millisecond, and a benchmark that compares two runs' final state
 * needs a total order that does not depend on the clock. The statement is unique per
 * task in the benchmark corpus and is what identifies the work anyway.
 */
export async function completedIntents(
  input: CompletedIntentsInput,
): Promise<CompletedIntent[]> {
  const { rows } = await getPool().query(
    `SELECT statement, status, tokens_spent, outcome
       FROM intents
      WHERE repo_id = $1
        AND status IN ('done', 'abandoned')
      ORDER BY statement`,
    [input.repoId],
  );

  return rows.map((row) => ({
    statement: row.statement as string,
    status: row.status as TerminalStatus,
    tokensSpent: Number(row.tokens_spent),
    outcome: row.outcome,
  }));
}
