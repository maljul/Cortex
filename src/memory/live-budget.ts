/**
 * THE LIVE RUN BUDGET — spec/04-ARCHITECTURE.md §5 brake 2, and rung 1 seen from the end
 * that decides.
 *
 * §5: "A run counter in CockroachDB, default 40 LIVE runs per day globally. On exhaustion
 * the UI switches to REPLAY and says so plainly."
 *
 * Two things about that sentence are implemented here and one is deliberately not.
 *
 * **Global, so the table has no tenant.** Every anonymous visitor mints a fresh session
 * scope, so a per-scope counter would cap nothing at all — a scripted visitor would simply
 * ask for another session. `live_run_budget` therefore holds a date and a count, and it is
 * the one table in this project exempt from invariant 5's `WHERE repo_id`. The exemption is
 * only sound while there is nothing in the table a tenant could own, so
 * `test/live-budget.test.ts` asks `information_schema` rather than taking this comment's
 * word for it.
 *
 * **What makes this safe under concurrency is SERIALIZABLE, not the shape of the statement
 * — measured, and the opposite of what this comment first claimed.** The obvious story is
 * that read-then-write in two statements lets two visitors both read 9 and both write 10,
 * and that the single `ON CONFLICT DO UPDATE ... WHERE` below is what closes it. That story
 * is wrong here. The mutation was run: replacing this with a separate read, a branch on the
 * cap, and an unguarded increment **still gives exactly three of ten concurrent callers a
 * slot**, because `withRetry` runs every one of them at SERIALIZABLE and a concurrent
 * increment invalidates the losing transaction's read. The isolation level is the brake.
 *
 * The single statement is kept for a smaller and truthful reason: it is one round trip to
 * CockroachDB Cloud instead of two, on the path in front of the run button.
 *
 * What *is* load-bearing is the cap living in the `WHERE`. Deleting `WHERE b.runs_used < $1`
 * fails six of the ten tests in `test/live-budget.test.ts`, including the concurrency one.
 * That is the assertion this file is actually held up by.
 *
 * **Not the same transaction as the whole scenario, and it cannot be.** `docs/UNITS.md`
 * asks for the counter to be "checked and incremented in the same transaction as the run it
 * authorises, or concurrent visitors race past it". The race is what that clause protects
 * and the race is closed above — but a demo run is deliberately *many* transactions, several
 * of them concurrent with each other (`07` §3 beat 3 is a real race between two of them), so
 * there is no single transaction to join. What this means in practice is that a slot is spent
 * when it is granted rather than when the run succeeds. That is the safe direction: a run
 * that dies after taking its slot costs one slot, where the other ordering would let a
 * failing run spend Bedrock tokens and give the slot back. Recorded in `docs/DECISIONS.md`.
 *
 * **Exhaustion is a return value, never an exception.** `05` §5: "POST /demo/run MUST NOT
 * fail when the LIVE quota is exhausted. It returns a replay run together with the reason it
 * is not live." `04` §5 invariant 1 says the same thing more strongly — no rung may present
 * an error page — and this is the rung most likely to be reached by an ordinary judge.
 */
import type { PoolClient } from 'pg';

import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';

/**
 * LIVE runs the demo will pay for in one day, globally.
 *
 * **`04` §5 says 40 and this is 10. Julian's call on 2026-08-12, from a measurement.**
 *
 * §5's own budget for the project is "single-digit dollars for the whole hackathon and
 * judging period", and until 2026-08-12 nobody could check the two against each other,
 * because the Bedrock rate for Sonnet 4.5 was TBD — AWS's pricing page did not return it
 * twice (V30) and its machine-readable Price List API does not carry the model at all.
 * The rate came from this account's own billing instead: Cost Explorer records
 * `Claude Sonnet 4.5 (Amazon Bedrock Edition)` as a service of its own at
 * **$3.30 per 1M input tokens and $16.50 per 1M output** — a Marketplace usage type, 1.10x
 * the familiar list price.
 *
 * Against the committed cassettes (30 calls: input 320/500/1067, output 59/72/111) a
 * five-agent run costs $0.0142 typically and $0.0268 at the observed maximum. So §5's 40
 * runs a day is $0.57–1.07 a day, or **$19–36 through 2026-09-15** — §5's default breaks
 * §5's budget. Ten a day is $4.83–9.10 over the same window: the largest round cap whose
 * worst case stays single digit.
 *
 * The deviation from §5's published 40 is recorded in `docs/SPEC-DELTA.md`. It is a cap and
 * not a floor: nothing degrades below REPLAY when it is reached, and REPLAY is fully live
 * database behaviour.
 *
 * **One source, like every other closed constant in this project.** There is deliberately
 * no environment variable: `05` §6 removed `CORTEX_DEDUPE_THRESHOLD` for the reason that
 * applies here too — a deployment running a number the published evidence does not describe
 * has un-closed the decision without a commit.
 */
export const LIVE_RUNS_PER_DAY = 10;

/**
 * The check and the increment, in one statement.
 *
 * `RETURNING` gives a row only when the `WHERE` on the conflict branch passed, so zero rows
 * *is* the exhaustion signal — no second read to issue. On the very first run of a day there
 * is no conflict and the INSERT lands `runs_used = 1`.
 *
 * The `WHERE` is the part that must not be lost; see the header for what its removal costs.
 *
 * `current_date` is the cluster's, never the caller's. A day supplied by an anonymous
 * browser would let a visitor pick which counter to spend, which is invariant 7's shape:
 * the only bind here is the cap, and the cap comes from this module.
 */
export const LIVE_BUDGET_CLAIM_SQL = `
  INSERT INTO live_run_budget AS b (day, runs_used)
  VALUES (current_date, 1)
  ON CONFLICT (day) DO UPDATE
     SET runs_used = b.runs_used + 1, updated_at = now()
   WHERE b.runs_used < $1
  RETURNING runs_used
`;

/** Today's spend, without spending any of it. Feeds `GET /demo/state`'s mode block. */
export const LIVE_BUDGET_READ_SQL = `
  SELECT runs_used
    FROM live_run_budget
   WHERE day = current_date
`;

export interface LiveBudget {
  used: number;
  cap: number;
  remaining: number;
}

export interface LiveAuthorisation extends LiveBudget {
  mode: 'live' | 'replay';
  /**
   * Why the mode is what it is, in the words the page shows. Always populated — a REPLAY
   * that cannot say why it is REPLAY is `04` §5 invariant 2's misrepresentation by omission.
   */
  reason: string;
}

export interface LiveBudgetOptions {
  /** Overridable for tests only. No route passes it; the shipped cap is the constant. */
  cap?: number;
  plane?: Plane;
  demoSession?: string;
  recorder?: StatementRecorder;
}

function scopeOf(options: LiveBudgetOptions): {
  plane: Plane;
  demoSession?: string;
  recorder?: StatementRecorder;
} {
  return {
    plane: options.plane ?? 'demo',
    ...(options.demoSession === undefined ? {} : { demoSession: options.demoSession }),
    ...(options.recorder ? { recorder: options.recorder } : {}),
  };
}

/**
 * The sentence rung 1 puts on screen.
 *
 * `04` §5's ladder gives rung 1 a "what is still true" column reading "database behaviour
 * fully live", and that half is not decoration: a page that says only "quota exhausted"
 * leaves a judge to assume the whole demo went static, which is the misrepresentation
 * invariant 2 forbids in the other direction. Both halves, every time.
 */
function exhaustedReason(cap: number): string {
  return (
    `The daily budget of ${cap} live reasoning runs is spent, so this run replays cached ` +
    'agent reasoning. Everything else is unchanged: every row on this page was committed ' +
    'by CockroachDB just now, and the arbitration, the dedupe distances and the change ' +
    'stream are all live.'
  );
}

function grantedReason(cap: number, used: number): string {
  return (
    `Live agent reasoning: this run called the model. ${cap - used} of ${cap} live runs ` +
    'remain today; after that the demo replays cached reasoning and says so.'
  );
}

/** Reads today's counter inside `client`'s transaction. */
async function readUsed(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ runs_used: string }>(LIVE_BUDGET_READ_SQL);
  return rows[0] ? Number(rows[0].runs_used) : 0;
}

/**
 * Takes a LIVE slot if one is left, and reports REPLAY with its reason if not.
 *
 * A write, so it goes through `withRetry` (invariant 6) — and here that is load-bearing
 * rather than ceremonial: this is the one row in the project every concurrent visitor
 * contends for, so 40001 is ordinary traffic on it and an unretried increment would surface
 * a serialization failure as an error page on the run button.
 */
export async function authoriseLiveRun(
  options: LiveBudgetOptions = {},
): Promise<LiveAuthorisation> {
  const cap = options.cap ?? LIVE_RUNS_PER_DAY;

  return withRetry(async (client) => {
    const { rows } = await client.query<{ runs_used: string }>(LIVE_BUDGET_CLAIM_SQL, [cap]);
    const taken = rows[0];

    if (!taken) {
      const used = await readUsed(client);
      return {
        mode: 'replay' as const,
        reason: exhaustedReason(cap),
        used,
        cap,
        remaining: Math.max(0, cap - used),
      };
    }

    const used = Number(taken.runs_used);
    return {
      mode: 'live' as const,
      reason: grantedReason(cap, used),
      used,
      cap,
      remaining: Math.max(0, cap - used),
    };
  }, scopeOf(options));
}

/** Today's spend, read and not altered. */
export async function liveBudget(options: LiveBudgetOptions = {}): Promise<LiveBudget> {
  const cap = options.cap ?? LIVE_RUNS_PER_DAY;

  return withRetry(async (client) => {
    const used = await readUsed(client);
    return { used, cap, remaining: Math.max(0, cap - used) };
  }, scopeOf(options));
}
