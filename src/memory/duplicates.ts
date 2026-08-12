/**
 * THE DEDUPE RULE, APPLIED AFTER THE FACT — spec/07 §1, spec/06-BENCHMARK-SPEC.md §3.
 *
 * `propose()` applies this rule *before* work happens, and refuses the duplicate. This
 * module applies the identical rule *after* work happened, to whatever an arm actually
 * did, and counts what a coordinating fleet would have avoided. That is the demo's meter
 * row `duplicate work done`, and both arms are measured by it:
 *
 * - CORTEX did the work of every agent it granted. The agent that would have duplicated
 *   was deduped, so it is not in the set, so the count is 0 — *observed*, not asserted.
 *   Had dedupe failed, that agent would be in the set and the count would be 1.
 * - NAIVE did the work of every agent, because nothing stopped any of them.
 *
 * Same rule, same threshold, same operator, two different inputs. The difference in the
 * answer is caused by the coordination layer and by nothing else, which is `07` §2's
 * requirement for the toggle to prove anything at all.
 *
 * **The distances come from the database, not from arithmetic here.** `07` §1 requires
 * every number on screen to be real and to come from the database, and CockroachDB's own
 * `<=>` is the operator the mechanism arbitrates on. Computing cosine in TypeScript would
 * have produced a number that agrees with the mechanism only for as long as two
 * implementations happen to agree — and it would have put a figure on the panel that the
 * cluster never saw. It is also why these statements appear in the show-SQL transcript:
 * a judge can read the distance and check it against the threshold beside it.
 *
 * All comparisons run inside **one** transaction. A transaction per pair would give the
 * panel a dozen BEGIN/COMMIT blocks around statements that are one measurement.
 */
import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';
import { toVector } from './propose.js';

/** The distance between two embeddings, computed by the cluster. */
export const DISTANCE_SQL = `
  SELECT $1::VECTOR(1024) <=> $2::VECTOR(1024) AS dist
`;

export interface WorkDone {
  /** How the caller identifies this piece of work. The demo passes an agent id. */
  key: string;
  statement: string;
  embedding: readonly number[];
}

export interface DuplicatedWork {
  /** The work that duplicated something already underway. */
  key: string;
  statement: string;
  /** The work it duplicated — always one that came earlier in the input order. */
  of: string;
  ofStatement: string;
  distance: number;
}

export interface DuplicatesOptions {
  plane?: Plane;
  demoSession?: string;
  recorder?: StatementRecorder;
  threshold: number;
}

/**
 * Which of these pieces of work duplicate an earlier one, at `threshold`.
 *
 * Single-linkage against the *accepted* set rather than all-pairs, so the count matches
 * what arbitration would have produced: the first of a duplicate group is work that had to
 * be done, and every later member is work that did not. Three agents on one task therefore
 * count as two duplicates, which is also what `propose()` would have refused.
 *
 * Input order is significant and is the order the work completed, so "of" always names
 * work that was genuinely already underway.
 */
export async function duplicatesAmong(
  work: readonly WorkDone[],
  options: DuplicatesOptions,
): Promise<DuplicatedWork[]> {
  if (work.length < 2) return [];

  const retryOptions = {
    ...(options.plane ? { plane: options.plane } : {}),
    ...(options.demoSession ? { demoSession: options.demoSession } : {}),
    ...(options.recorder ? { recorder: options.recorder } : {}),
  };

  return withRetry(async (client) => {
    const accepted: WorkDone[] = [];
    const duplicates: DuplicatedWork[] = [];

    for (const candidate of work) {
      let nearest: DuplicatedWork | null = null;

      for (const earlier of accepted) {
        const { rows } = await client.query<{ dist: string }>(DISTANCE_SQL, [
          toVector(candidate.embedding),
          toVector(earlier.embedding),
        ]);
        const distance = Number(rows[0]?.dist);

        if (distance < options.threshold && (nearest === null || distance < nearest.distance)) {
          nearest = {
            key: candidate.key,
            statement: candidate.statement,
            of: earlier.key,
            ofStatement: earlier.statement,
            distance,
          };
        }
      }

      if (nearest) duplicates.push(nearest);
      else accepted.push(candidate);
    }

    return duplicates;
  }, retryOptions);
}
