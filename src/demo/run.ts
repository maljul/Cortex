/**
 * THE RUN STREAM — one visitor's fleet run, published as it happens. Design §5.1 and §5.3.
 *
 * `POST /demo/run` hands this off and returns a `runId`; everything the run does arrives here and
 * goes out over the WebSocket the changefeed already uses.
 *
 * **The reason is not the one design §5.1 gives, and the difference was measured (V51).** §5.1
 * says "a ten-task two-arm run will exceed API Gateway HTTP's integration ceiling (~30s)". The
 * ceiling is real — 30,000ms on this deployment — but the run does **not** exceed it: deployed
 * in-region, both arms complete in **5.9–8.3 seconds**, and a synchronous invocation answered in
 * **4548ms**. The same run takes ~50 seconds from a laptop, and the gap is round-trip latency
 * over roughly three hundred statements per arm, not work. So the async shape was forced by a
 * premise that measurement falsified, and it is kept for reasons that survive it:
 *
 *   - **The stream is the product.** Design §9 wants every agent step visible as it happens, so a
 *     judge watches the collision rather than reading that it occurred. That is not a workaround
 *     for a timeout; it is the demo.
 *   - **LIVE will exceed the ceiling.** Design §7.3 puts a metered run at ~50 model calls; at
 *     seconds each that is past 30s on its own, and U24 must not have to change this shape to get
 *     there. `07` §1 budgets ninety seconds for a run, which no response can carry.
 *   - **The margin is 3.6×, not a hundred.** A cold pool adds ~1.4s, contention adds retries, and
 *     8.3s of a ten-slot account-wide concurrency budget per visitor is expensive where 482ms is
 *     not.
 *
 * Recorded in `docs/SPEC-DELTA.md` rather than left as a comment that quietly disagrees with the
 * design it implements.
 *
 * **The named silent break is a run that dies after the 200 has been sent.** The visitor gets a
 * page that never finishes and never errors — `04` §5 invariant 1 satisfied to the letter and
 * broken in spirit. So this module's contract is not "publish the events"; it is:
 *
 *   1. exactly one terminal message is published, on every path;
 *   2. nothing is published after it;
 *   3. a page that received the terminal message knows whether the run finished or stopped, and
 *      if it stopped, why.
 *
 * **Two paths reach it and only one is a throw.** The other is the runner Lambda hitting its own
 * timeout, which kills the process without running any `finally` — so the watchdog is here, in
 * code a test can force with a 60ms budget, rather than in `infra/lambda/runner.ts` where it
 * would only ever have been seen firing in production. `test/run-stream.test.ts` drives both.
 *
 * **The arms run one after the other, deliberately.** Ten agents at once is within reach — V51
 * measured ten concurrent transactions on the demo plane committing in 2497ms against a 2s sleep,
 * with `pg`'s pool max at exactly 10 — but running the arms together would have each arm's
 * `claim_p50` and `serialization_retries` measured under the other arm's load, and `06` §3's
 * numbers are the comparison. Deployed, sequential is 5.9–8.3s against `07` §1's ninety-second
 * budget, so concurrency would buy a few seconds nobody is short of at the cost of the meter
 * meaning something else. If that trade is ever revisited, the pool headroom is measured and
 * written down.
 *
 * Deliberately free of AWS types, for the reason `src/demo/api.ts` gives: a sink that can only be
 * exercised by deploying it is a sink that is exercised once.
 */
import type { StatementRecorder } from '../db/recorder.js';
import {
  runArm,
  type ArmMeter,
  type ArmOptions,
  type ArmResult,
  type DemoArm,
  type FleetEvent,
} from './workload.js';

/** One `repos` row per arm, per design §4.1. */
export interface RunScopes {
  cortex: string;
  naive: string;
}

/** What a page needs about one arm once it is over. The trees are not on the wire — see below. */
export interface ArmSummary {
  arm: DemoArm;
  scope: string;
  events: number;
  beats: ArmResult['beats'];
  meter: ArmMeter;
  steps: ArmResult['steps'];
}

/**
 * What goes over the socket.
 *
 * **Labelled differently from a changefeed row, and that is design §5.3 rather than a naming
 * preference.** The changefeed's messages are `{type: 'change', topic, scope, after, updated}`
 * and each carries the row's own primary key, because each *is* a row the cluster committed. A
 * fleet event is not a row and nothing invents a table to make it one — so it carries no `topic`,
 * no `after`, no `key` and no `updated`, and `test/run-stream.test.ts` fails if any of them ever
 * appears. What it does carry is the arm's scope, so the page can put the event in the right
 * swimlane and line it up against that scope's real rows.
 */
export type RunMessage =
  | { type: 'run'; runId: string; phase: 'started'; at: number; scopes: RunScopes }
  | { type: 'fleet'; runId: string; scope: string; event: FleetEvent }
  | {
      type: 'run';
      runId: string;
      phase: 'finished';
      at: number;
      arms: ArmSummary[];
      undelivered: number;
    }
  | { type: 'run'; runId: string; phase: 'failed'; at: number; reason: string; undelivered: number };

export interface StreamRunOptions {
  runId: string;
  scopes: RunScopes;
  embed: (text: string) => Promise<number[]>;
  /** May be async. Publishing is serialised so the page sees events in the order they happened. */
  publish: (message: RunMessage) => void | Promise<void>;
  /**
   * Wall-clock budget. When it elapses the terminal message is published **without waiting for
   * the run**, which is the only way to beat a Lambda deadline. Unset means no watchdog, which is
   * correct for a local caller that cannot be killed.
   */
  budgetMs?: number;
  /** Per arm, so `claim_p50` has statements to compute from and the show-SQL panel has a source. */
  recorders?: Partial<Record<DemoArm, StatementRecorder>>;
  /** The seam `test/run-stream.test.ts` uses to force a throw, a stall, and a broken socket. */
  run?: (options: ArmOptions) => Promise<ArmResult>;
}

export interface RunOutcome {
  runId: string;
  phase: 'finished' | 'failed';
  at: number;
  /** Whole results, trees included. Not published — see `ArmSummary`. */
  arms: ArmResult[];
  undelivered: number;
  reason?: string;
}

const ARMS: readonly DemoArm[] = ['cortex', 'naive'];

function summarise(result: ArmResult): ArmSummary {
  return {
    arm: result.arm,
    scope: result.sessionId,
    events: result.events.length,
    beats: result.beats,
    meter: result.meter,
    steps: result.steps,
  };
}

/** What to tell the page. An `Error`'s message; anything else stringified rather than dropped. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Runs both arms and publishes the whole run.
 *
 * **Never rejects.** A caller that has to handle an exception from this function is a caller that
 * can forget to, and the one thing this module exists to guarantee is that somebody is told how
 * the run ended. The outcome is the return value, and it has already been published.
 */
export async function streamRun(options: StreamRunOptions): Promise<RunOutcome> {
  const { runId, scopes, embed, publish, budgetMs, recorders, run = runArm } = options;
  const started = Date.now();

  const results: ArmResult[] = [];
  let undelivered = 0;
  let terminated = false;

  /**
   * Publishing is a chain rather than a set of parallel awaits, because order is the point: a
   * judge watching a collision happen is watching a sequence, and two events posted concurrently
   * to one socket arrive in whichever order the network chose.
   *
   * A publish that throws costs its own message and nothing else. `infra/lambda/changefeed.ts`
   * already takes that position for rows — "one bad socket must not cost the rest of the batch
   * its delivery" — and a run that abandoned itself because a visitor closed a tab would be the
   * same defect from the other side. The count is reported on the terminal message rather than
   * swallowed, so a page that received 40 of 42 events knows it.
   */
  let chain: Promise<void> = Promise.resolve();
  const send = (message: RunMessage): void => {
    if (terminated) return;
    chain = chain.then(async () => {
      try {
        await publish(message);
      } catch {
        undelivered += 1;
      }
    });
  };

  send({ type: 'run', runId, phase: 'started', at: 0, scopes });

  type Settled = { phase: 'finished' } | { phase: 'failed'; reason: string };

  const perform = async (): Promise<void> => {
    for (const arm of ARMS) {
      const recorder = recorders?.[arm];
      const result = await run({
        sessionId: scopes[arm],
        arm,
        embed,
        ...(recorder ? { recorder } : {}),
        onEvent: (event) => send({ type: 'fleet', runId, scope: scopes[arm], event }),
      });
      results.push(result);
    }
  };

  // Rejection is folded into the value here rather than left on the promise: on the watchdog path
  // nobody awaits this again, and an unobserved rejection would take the process down by way of
  // an unhandled rejection — which is the silent break wearing a different hat.
  const running: Promise<Settled> = perform().then(
    () => ({ phase: 'finished' as const }),
    (error: unknown) => ({ phase: 'failed' as const, reason: reasonOf(error) }),
  );

  let watchdog: NodeJS.Timeout | undefined;
  const outcome: Settled = await (budgetMs === undefined
    ? running
    : Promise.race([
        running,
        new Promise<Settled>((resolve) => {
          watchdog = setTimeout(
            () =>
              resolve({
                phase: 'failed',
                reason:
                  `The run did not finish inside its ${budgetMs}ms budget and was cut short. ` +
                  'Everything reported before this point happened.',
              }),
            budgetMs,
          );
        }),
      ]));
  if (watchdog) clearTimeout(watchdog);

  // Every event already queued goes out first, and then the channel is closed **before** the
  // terminal message is queued rather than after it. The order matters and only on the watchdog
  // path, which is the one this module exists for: there the run is still going and still
  // emitting, so a guard set afterwards leaves a window in which a late fleet event lands behind
  // the terminal message. Nothing may follow it on the wire.
  await chain;
  terminated = true;

  const terminal: RunMessage =
    outcome.phase === 'finished'
      ? {
          type: 'run',
          runId,
          phase: 'finished',
          at: Date.now() - started,
          arms: results.map(summarise),
          undelivered,
        }
      : {
          type: 'run',
          runId,
          phase: 'failed',
          at: Date.now() - started,
          reason: outcome.reason,
          undelivered,
        };

  // Queued directly, because `send` now refuses everything.
  chain = chain.then(async () => {
    try {
      await publish(terminal);
    } catch {
      undelivered += 1;
    }
  });
  await chain;

  return {
    runId,
    phase: outcome.phase,
    at: Date.now() - started,
    arms: results,
    undelivered,
    ...(outcome.phase === 'failed' ? { reason: outcome.reason } : {}),
  };
}
