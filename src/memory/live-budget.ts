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
 *
 * **The capability check lives here too, and that is not filing convenience.** Design §7.1's
 * token and §5's counter are the same question asked twice — *may this visitor spend model
 * tokens* — and they are answered in two different processes: `POST /demo/run` authorises, and
 * `infra/lambda/runner.ts` re-checks, because the runner receives a payload it cannot
 * authenticate and a `mode: live` field in it would otherwise be a claim rather than a proof.
 * Both import this module; neither imports the other.
 */
import { timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { Plane } from '../db/pool.js';
import type { StatementRecorder } from '../db/recorder.js';
import { withRetry } from '../db/retry.js';

/**
 * THE CAPABILITY LINK — design §7.1, and invariant 7 applied to the most agent-reachable
 * path there is.
 *
 * "An unguessable token in the URL (`/?live=<token>`), pasted only into the Devpost
 * submission, enables the RUN LIVE control. The token is compared server-side; it never
 * appears in an input element, and the page contains no field of any kind."
 *
 * Three properties, each of which has cost this project or a sibling real time:
 *
 * - **Compared, never interpolated.** Nothing structural crosses this boundary: the value is
 *   read, length-checked and byte-compared, and it reaches no SQL, no template and no log.
 *   `timingSafeEqual` rather than `===`, because a token that leaks its prefix through
 *   response timing is a token an unattended script can walk.
 * - **Absent or wrong is indistinguishable from the public page.** This returns `false` and
 *   the caller serves exactly what an anonymous visitor gets — no error, no hint that a gate
 *   exists, per `04` §5 invariant 1.
 * - **Unset means unavailable, never a fault.** A deployment without the secret serves REPLAY
 *   for ever. `05` §5's degradation rule is that a limit resolves to a working page, and a
 *   missing capability is the most ordinary limit of all.
 *
 * The expected value arrives in `LIVE_TOKEN` from Secrets Manager as a
 * `{{resolve:secretsmanager:...}}` dynamic reference, never a template value — the first DSN
 * arrangement leaked one into `cdk.out/` and that is the whole reason that rule exists.
 *
 * Read from the environment on every call rather than at module scope: a module-scope read
 * runs before the Lambda's environment is in place, which is exactly what bit `Embedder` in U8.
 */
export function liveCapabilityGranted(
  presented: string | undefined | null,
  expected: string | undefined = process.env['LIVE_TOKEN'],
): boolean {
  if (!expected || !presented) return false;

  const offered = Buffer.from(presented, 'utf8');
  const secret = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` throws on unequal lengths, so the guard is required rather than an
  // optimisation. It leaks the length of the secret and nothing else, which is a property of
  // the alphabet the secret is generated in and is public anyway.
  if (offered.length !== secret.length) return false;

  return timingSafeEqual(offered, secret);
}

/**
 * The whole-event LIVE budget, in dollars. **Julian's call, 2026-08-16.**
 *
 * `04` §5's own target is "single-digit dollars for the whole hackathon and judging period",
 * and this is the number that phrase was resolved to. It is the budget for *reasoning*: the
 * embedding line, the cluster, Lambda, S3 and CloudFront are all separately measured at
 * effectively zero at demo volumes and are not charged against it.
 */
export const LIVE_BUDGET_USD = 9;

/**
 * The window the budget has to cover, in days: 2026-08-16 through 2026-09-15 inclusive.
 *
 * Rule B4 requires the project to stay available free and unrestricted until 2026-09-15, so
 * the budget is not "until the deadline", it is "until judging ends". Fixed at the window's
 * full length rather than recomputed from today's date, deliberately: a number that changed
 * every morning would be untestable and unreviewable.
 *
 * **It does not derive the cap — see `LIVE_RUNS_PER_DAY`.** It is here to quantify what brake 3
 * has to stop, which is the one honest use a daily counter can put it to.
 */
export const LIVE_BUDGET_WINDOW_DAYS = 31;

/**
 * The Bedrock reasoning rate this account has actually been billed at, per million tokens.
 *
 * **Measured, not quoted (V36).** AWS's pricing page failed to render the row twice, and its
 * machine-readable Price List API does not carry the model at all — re-checked on 2026-08-16,
 * where the whole `AmazonBedrock` catalogue for `us-east-1` still stops at Claude 3 and the
 * `AWSMarketplace` catalogue returns nothing for Claude. The rate came from this account's own
 * Cost Explorer instead, where `Claude Sonnet 4.5 (Amazon Bedrock Edition)` is a **service of
 * its own**, separate from `Amazon Bedrock`.
 *
 * **This is Sonnet 4.5's rate and the fleet runs Haiku 4.5, and that substitution is the one
 * thing to read carefully here.** Haiku 4.5's own rate is not confirmable today: Cost Explorer
 * lags roughly a day and 2026-08-16 is this account's first Haiku usage, so there is no billed
 * line to read. The choice was between writing an estimate into config — which this repository
 * does not do — and pricing the run at the one reasoning rate this account has been billed at.
 * Every published rate card puts Haiku below Sonnet, so pricing a Haiku run at Sonnet's rate
 * makes the derived cap **a floor**: when the Haiku line appears and the rate is lower, the cap
 * can only rise, and no arrangement of that number can overspend `LIVE_BUDGET_USD`.
 *
 * `npm run gate:ladder` re-asks Cost Explorer for the Haiku service line on every run and says
 * whether this rate is still the best available one, so tightening it is a check rather than a
 * thing somebody has to remember.
 */
export const MEASURED_REASON_RATE_USD_PER_MTOK = { input: 3.3, output: 16.5 } as const;

/** What one LIVE fleet run actually spent at Bedrock, from Bedrock's own `usage`. */
export interface MeteredRun {
  /** The day it was run, so a stale measurement is visible rather than inferred. */
  at: string;
  /** Model calls the run made. Both arms, every ticket that wrote anything. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * THE METERED RUN — U24's done-when, and the only input to the cap that is not a decision.
 *
 * "One metered LIVE run exists and the cap is derived from it, not estimated." Design §7.3 put
 * a run at "≈50 model calls … ≈75k input and 15k output tokens" and labelled that an estimate
 * from a secondary source. These figures are not that: they are the sum of Bedrock's own
 * `usage` block over one real two-arm run against the real cluster, collected by
 * `npm run gate:ladder -- --meter`.
 *
 * `null` would mean no such run exists, in which case `LIVE_RUNS_PER_DAY` below is 0 and LIVE
 * is simply unavailable — design §7.3's own instruction, "until both exist, the config carries
 * TBD and LIVE stays disabled", expressed as a value rather than as a comment.
 */
export const METERED_LIVE_RUN: MeteredRun | null = {
  at: '2026-08-16',
  calls: 16,
  inputTokens: 36892,
  outputTokens: 10255,
};

/**
 * **Two of those sixteen calls are charged rather than reported, and that correction is the
 * difference between a measurement and a plausible number.**
 *
 * `modelAuthor` throws on `stop_reason === 'max_tokens'` — correctly, because half a JSON
 * object is a broken edit and not a smaller one — but it throws *before* returning Bedrock's
 * `usage`, so a truncated call is billed by AWS and reported to nobody. Metering a run from
 * `AuthorResult.usage` alone therefore understates it every time. The first metered run lost
 * two calls that way and came out at $0.2478 against a true $0.2910: enough to move the derived
 * cap.
 *
 * They are charged in `scripts/gate-ladder.mts` at a bound rather than an estimate — output at
 * exactly `FLEET_MAX_OUTPUT_TOKENS`, which is *why* the call stopped, and input at the largest
 * prompt any call in the run reported. The figures above are the charged totals.
 *
 * **Two runs, taken minutes apart, reported the same 30,506 measured input tokens, the same 16
 * calls and the same 2 truncations.** The prompt is the corpus and the ticket, so the input
 * side is deterministic; only the output side moves — 7,455 and 8,915 measured — which is the
 * model writing. The figures above are the second run's, the one taken with the instrumentation
 * that can charge a truncation, so **this is not a worst case**: the first run's output was
 * about a fifth higher. It is nonetheless conservative overall, because the rate it is priced
 * at is a dearer model's (see `MEASURED_REASON_RATE_USD_PER_MTOK`) by roughly threefold, which
 * swamps a fifth either way. Re-derive it if the corpus, the ticket set or the prompt changes.
 */

/** What a run of that size costs at the rate above. */
export function liveRunCostUsd(run: MeteredRun): number {
  return (
    (run.inputTokens / 1_000_000) * MEASURED_REASON_RATE_USD_PER_MTOK.input +
    (run.outputTokens / 1_000_000) * MEASURED_REASON_RATE_USD_PER_MTOK.output
  );
}

/**
 * LIVE runs the demo will pay for in one day, globally — **derived, never written**.
 *
 * `04` §5 says 40. Julian's call on 2026-08-12 made it 10, against the *old* five-agent
 * scenario, and `docs/UNITS.md` recorded that the number was wrong for this workload by
 * roughly an order of magnitude and gated nothing, because no route called
 * `authoriseLiveRun`. Both halves of that are now closed: the route calls it, and the number
 * below is computed from design §7.3's formula rather than chosen.
 *
 *     cap = LIVE budget ÷ measured cost of one metered run
 *
 * At $0.2910 a metered run that is **30**, and its meaning is exactly one sentence: *no single
 * day may spend more than the entire LIVE budget.*
 *
 * ── THE QUESTION `docs/UNITS.md` REFUSED TO GUESS AT, AND WHAT MEASURING IT ANSWERED ──
 *
 * "Consider whether a whole-event budget is honestly enforced by a per-UTC-day counter." It is
 * not, and the measurement is what proves it rather than the argument. The obvious construction
 * is to make the daily cap small enough that spending it every day of the window still fits —
 * `cap = budget ÷ (days × cost)`. Run the numbers that were actually measured and it comes out
 * at **0.9978**, which floors to zero. There is no daily integer that means "thirty runs over
 * thirty-one days": the granularity of a daily counter cannot express a cumulative budget, and
 * at this budget and this cost it quantises to *nothing at all* or to *the whole thing*.
 *
 * So the counter is given the job it can actually do — bound the day — and the cumulative bound
 * is left where `04` §5 put it in the first place. §5's three brakes divide the work: brake 2 is
 * "a run counter … N LIVE runs per day", a **rate**, and brake 3 is "an AWS Budget alarm …
 * above a low-double-digit threshold", the only one of the three §5 gives a *monetary* limit to.
 * Trying to make brake 2 do brake 3's job is what produced the zero.
 *
 * **Brake 3 is built, and `LIVE_UNBRAKED_WINDOW_USD` below is what it prevents.** This paragraph
 * read "specified and NOT BUILT" until 2026-08-16, and the figure it named — thirty-one
 * consecutive maxed days at **$270.58** — is exactly why it did not stay that way. The stack now
 * carries an ANNUAL $9 cost budget filtered on the two `(Amazon Bedrock Edition)` services, whose
 * action attaches a Deny on `bedrock:InvokeModel` to the runner's role. So the cumulative bound
 * `04` §5 assigns to brake 3 exists, and the day-rate bound above is brake 2's alone, which is
 * the division §5 intended.
 *
 * **The residual that replaces it, because there is always one.** AWS Budgets evaluate against
 * cost data that refreshes a few times a day, not continuously — so the brake is a *bound*, not
 * an interlock, and spend can overshoot within one refresh window before the Deny lands. Two
 * things keep that overshoot small and neither is a substitute for knowing about it: LIVE is
 * reachable only by a holder of the capability token, which goes into the Devpost submission and
 * nowhere else, and the rate below is a **dearer model's** — the metered run is priced at Sonnet's
 * confirmed rate because Haiku's had not yet appeared in Cost Explorer, so thirty runs of actual
 * Haiku spend is nearer $3 than $9. When the Haiku line lands, one constant tightens this.
 *
 * Deliberately not clamped to at least 1. A run this project cannot afford once is a run it
 * cannot offer, and the honest expression of that is a cap of zero and a REPLAY demo.
 *
 * **One source, like every other closed constant in this project.** There is deliberately no
 * environment variable: `05` §6 removed `CORTEX_DEDUPE_THRESHOLD` for the reason that applies
 * here too — a deployment running a number the published evidence does not describe has
 * un-closed the decision without a commit.
 *
 * The deviation from §5's published 40 is recorded in `docs/SPEC-DELTA.md`. It is a cap and
 * not a floor: nothing degrades below REPLAY when it is reached, and REPLAY is fully live
 * database behaviour.
 */
export const LIVE_RUNS_PER_DAY: number =
  // A run that cost nothing is a run in which no call reached Bedrock — every author fell back
  // — and dividing by it would produce an unbounded cap out of a failed measurement. That is
  // the same class of mistake as `06` §6's "a count over an empty list renders exactly like a
  // count over real work", and it is refused here rather than rendered.
  METERED_LIVE_RUN === null || liveRunCostUsd(METERED_LIVE_RUN) <= 0
    ? 0
    : Math.floor(LIVE_BUDGET_USD / liveRunCostUsd(METERED_LIVE_RUN));

/**
 * What a full window of maxed days would cost, at the cap above and the rate above.
 *
 * Exported because it is the number brake 3 exists to stop, and a specification for a brake
 * that does not say what it is stopping is a specification nobody can check. `04` §5 calls for
 * an action "above a low-double-digit threshold"; this is what that threshold is protecting
 * against.
 */
export const LIVE_UNBRAKED_WINDOW_USD: number =
  METERED_LIVE_RUN === null
    ? 0
    : LIVE_RUNS_PER_DAY * LIVE_BUDGET_WINDOW_DAYS * liveRunCostUsd(METERED_LIVE_RUN);

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

/**
 * What every ordinary visitor's run is, and the only thing said about it.
 *
 * `07` §4 prescribes "replay mode: agent reasoning is cached, all database behaviour is live",
 * and this is that sentence made accurate for what actually happens: the cache is a reviewed
 * patch set rather than a cassette, and the database half is unqualified. **It names no quota
 * and no capability**, because design §7.1 requires the page to render exactly as the public
 * page does when no token is presented — a REPLAY notice that mentioned a live budget would be
 * the hint that a gate exists.
 */
export const PUBLIC_REPLAY_REASON =
  'Replay mode: each agent applies a reviewed patch instead of calling a model. Everything ' +
  'else is live — every row on this page was committed by CockroachDB just now, and the ' +
  'arbitration, the dedupe distances, the retries and the change stream all happened.';

/**
 * The sentence for a deployment that has no LIVE capability configured at all.
 *
 * Distinct from exhaustion because it is a different fact: nothing was spent and nothing is
 * left to spend. Reached only by a caller that already presented a valid token, so it can name
 * the capability without hinting at one to anybody else.
 */
function unconfiguredReason(): string {
  return (
    'Live agent reasoning is not available on this deployment, so this run replays reviewed ' +
    'patches. Everything else is unchanged: every row on this page was committed by ' +
    'CockroachDB just now, and the arbitration, the dedupe distances and the change stream ' +
    'are all live.'
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

  /**
   * A cap of zero is not exhaustion and the statement below cannot express it.
   *
   * `LIVE_BUDGET_CLAIM_SQL`'s `WHERE` guards the *conflict* branch only, so on the first call
   * of a day there is no row, the INSERT lands `runs_used = 1`, and the cap is never consulted
   * — which is correct for every positive cap and wrong for zero. That is reachable: the cap is
   * derived, and it is zero whenever no metered run exists or one run costs more than the
   * window can afford. Refusing here rather than adding a second predicate keeps the claim a
   * single round trip and keeps the reason honest: nothing was spent, so nothing was counted.
   */
  if (cap <= 0) {
    return { mode: 'replay' as const, reason: unconfiguredReason(), used: 0, cap, remaining: 0 };
  }

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
