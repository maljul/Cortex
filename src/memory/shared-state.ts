/**
 * THE NAIVE ARM'S SHARED WORK STATE — spec/06-BENCHMARK-SPEC.md §2, spec/07 §2.
 *
 * **This is not a memory tier.** `03` §2 has four and this is none of them. It is the
 * thing a fleet uses *instead* of shared memory: one blob of JSON that every agent reads
 * at the start of its task and writes back whole at the end. `06` §2 specifies exactly
 * that for the NAIVE arm — "shared state: JSON file on disk, last-write-wins" — and
 * `bench/arms/naive.ts` already implements it against a real file. This module is the same
 * mechanism against a real row, so the hosted demo's naive arm performs work and loses it
 * for the same reason the benchmark's does.
 *
 * It lives in `src/memory/` because that is where this repository keeps SQL
 * (`scripts/gate-mechanical.sh` enforces it), not because it is memory.
 *
 * **Why the read and the write are two transactions, and why that is the fair shape.**
 * `06` §2 requires the naive arm to be a fair representation of what people do today
 * rather than a strawman, and the honest reading is that a naive agent's work happens
 * *outside* the database — it reads the shared file, edits code for minutes, and saves.
 * There is no transaction spanning that. Putting the read and the write inside one
 * SERIALIZABLE transaction would make CockroachDB detect the conflict and `withRetry`
 * resolve it, so the naive arm would silently inherit the very guarantee the CORTEX arm
 * exists to provide — and the demo would show no difference at all. Two transactions is
 * not a handicap applied to the naive arm; it is what "no coordination" means.
 *
 * Nothing here is scripted to fail. Neither function drops an entry, neither checks whose
 * entry it is, and neither delays. The loss falls out of the read-work-write shape when two
 * agents overlap, and whether it happens on any given run is decided by the race.
 */
import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';

/** One agent's record of the work it did. The naive analogue of an intent, with no id. */
export interface SharedWorkEntry {
  agent: string;
  statement: string;
  resourceKeys: string[];
  note: string;
}

/**
 * Keyed by **agent**, not by task.
 *
 * Two agents doing the same work must produce two entries, because that duplication is the
 * thing the demo is measuring. Keyed by task they would collide and the second would
 * quietly overwrite the first, which would hide duplicate work behind the same
 * last-write-wins that hides lost writes — one mechanism reported as two.
 */
export interface SharedWorkState {
  completed: Record<string, SharedWorkEntry>;
}

export const SHARED_STATE_SELECT_SQL = `
  SELECT demo_shared_state
    FROM repos
   WHERE id = $1
`;

export const SHARED_STATE_UPDATE_SQL = `
  UPDATE repos
     SET demo_shared_state = $2
   WHERE id = $1
`;

export interface SharedStateOptions {
  plane?: Plane;
  demoSession?: string;
  recorder?: StatementRecorder;
}

function retryOptions(options: SharedStateOptions): SharedStateOptions {
  return {
    ...(options.plane ? { plane: options.plane } : {}),
    ...(options.demoSession ? { demoSession: options.demoSession } : {}),
    ...(options.recorder ? { recorder: options.recorder } : {}),
  };
}

/**
 * Reads the whole cell into a snapshot the caller then holds while it works.
 *
 * A read, and it still goes through `withRetry` — not for the 40001 (there is nothing to
 * conflict with) but because the demo session scope is transaction-local by construction
 * (`is_local = true`, see `src/db/retry.ts`), so a statement outside a transaction would
 * carry no scope and the policy would match nothing.
 */
export async function loadSharedState(
  repoId: string,
  options: SharedStateOptions = {},
): Promise<SharedWorkState> {
  return withRetry(async (client) => {
    const { rows } = await client.query<{ demo_shared_state: SharedWorkState | null }>(
      SHARED_STATE_SELECT_SQL,
      [repoId],
    );
    return rows[0]?.demo_shared_state ?? { completed: {} };
  }, retryOptions(options));
}

/**
 * Writes the snapshot back, whole.
 *
 * The entire mechanism is in the word *whole*. Whatever another agent committed since this
 * snapshot was taken is not in it, so this statement reverts it. That is what last-write-
 * wins on a whole-artifact rewrite does, it is what `06` §2 specifies for this arm, and a
 * merge here would both hide the effect and be a coordination mechanism in its own right.
 *
 * Returns the number of rows the UPDATE actually changed, so the caller can tell an
 * acknowledged write from one the policy refused. A zero would mean the scope was not
 * live — a real outcome the demo should report rather than assume away.
 */
export async function saveSharedState(
  repoId: string,
  state: SharedWorkState,
  options: SharedStateOptions = {},
): Promise<number> {
  return withRetry(async (client) => {
    const result = await client.query(SHARED_STATE_UPDATE_SQL, [repoId, JSON.stringify(state)]);
    return result.rowCount ?? 0;
  }, retryOptions(options));
}
