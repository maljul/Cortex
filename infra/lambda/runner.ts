/**
 * THE RUNNER — one visitor's fleet run, off the request path. Design §5.1 and §5.2.
 *
 * `POST /demo/run` in fleet mode invokes this asynchronously and answers `{ runId }` at once. The
 * reason is **not** that the run would blow the gateway ceiling — V51 measured that it does not,
 * 5.9–8.3s against 30,000ms — but that the stream is the demo, and that U24's LIVE mode will. The
 * full argument is in `src/demo/run.ts`'s header, where the shape is decided.
 *
 * **This is the second of a visitor's two invocations and there is no third.** Design §5.2 fixes
 * the arithmetic: this account's Lambda concurrency is 10, cannot be raised from the CLI and
 * cannot be subdivided (V22, V26), so ten agents as ten Lambdas would consume the entire account
 * for one visitor. The agents are async tasks *inside* this function, sharing one pool — five at
 * a time per wave, which V51 measured comfortable: ten concurrent transactions on the demo plane
 * committed in 2497ms against a 2s sleep, with `pg`'s pool max at exactly 10.
 *
 * **A run deployed here is roughly seven times faster than the same run from a laptop** (~50s),
 * because this function and the cluster are both in `us-east-1` and a run issues on the order of
 * three hundred statements per arm. Any timing read off `npm run gate:workload` is a
 * laptop-to-cloud number and says nothing about what a visitor waits.
 *
 * **Everything this file adds to `streamRun` is a deadline.** The named silent break of U22 is a
 * run that dies after the 200 has already gone out, and a Lambda that reaches its timeout dies
 * without running a single `finally` — so the budget below is handed to `src/demo/run.ts`, which
 * owns the watchdog and is tested firing it. Nothing here decides how a run ends; it only says
 * when this sandbox stops existing.
 */
import { StatementRecorder } from '../../src/db/recorder.js';
import { modelAuthor, type AuthorResult, type PatchAuthor } from '../../src/demo/author.js';
import { streamRun, type RunScopes } from '../../src/demo/run.js';
import { writeSqlLog } from '../../src/demo/sql-log.js';
import { Embedder } from '../../src/embed/titan.js';
import { liveCapabilityGranted, liveRunCostUsd } from '../../src/memory/live-budget.js';
import { broadcast, requireFanoutEnvironment } from './fanout.js';
import { installSqlLogStore } from './sql-log-store.js';

interface RunEvent {
  runId?: unknown;
  scopes?: { cortex?: unknown; naive?: unknown };
  /** Present only when `POST /demo/run` authorised LIVE and spent a slot. See `RunJob`. */
  live?: { capability?: unknown };
}

/** The subset of Lambda's context this handler reads. */
interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
}

/**
 * Bumped by hand on each redeploy, as the demo and identity handlers' are.
 *
 * It cannot detect every stale deploy, and 2026-08-17 is why this says so. `e35cacc` fixed
 * `lostWrites` in `src/demo/workload.ts`, which is bundled *into* this handler — deployed
 * behaviour changed while this file did not, so the marker read 4 on both sides of the fix
 * and the deployed runner reported the project's headline claim inverted. The marker proves
 * a deploy landed; it does not prove the bundle is current with the tree.
 */
const BUNDLE_REVISION = 5;

/**
 * How much of the sandbox's remaining life is reserved for ending the run properly.
 *
 * The terminal message costs a DynamoDB scan and a post per listening socket, and the two
 * transcripts cost a write each. Ten seconds is generous against a 180-second function and against
 * a run measured at 5.9–8.3s, and generous is the right side to be wrong on: the whole point of
 * the watchdog is that the message gets out, and a margin too thin to publish it is the same as no
 * watchdog at all.
 */
const TERMINAL_MARGIN_MS = 10_000;

// Lazily built, like `getPool()`: a module-scope `Embedder` would read `BEDROCK_REGION` before
// the handler's environment is in place. U8 hit exactly that.
let cachedEmbedder: Embedder | undefined;
function embedder(): Embedder {
  cachedEmbedder ??= new Embedder();
  return cachedEmbedder;
}

installSqlLogStore();

/** What one run spent at Bedrock, summed from Bedrock's own `usage`. U24's metered figure. */
export interface RunUsage {
  /** Calls that reached Bedrock and came back with a `usage` block. */
  calls: number;
  /** Calls whose answer survived validation and was applied. */
  authored: number;
  /** Calls whose answer did not, and which fell back to the reviewed patch. */
  fellBack: number;
  inputTokens: number;
  outputTokens: number;
  /** Why each rejection happened, so a run that quietly authored nothing is visible. */
  rejections: string[];
}

/**
 * THE LIVE AUTHOR, AND THE SECOND CHECK ON THE TOKEN.
 *
 * `POST /demo/run` authorised this run and spent a slot for it, then invoked this function
 * asynchronously with a payload it cannot sign. So `live` arriving in that payload is a claim;
 * comparing the capability it carries against this function's own copy of the secret is what
 * makes it a proof. Two functions, one Secrets Manager value, checked twice — and if the
 * comparison fails, the run is a perfectly good REPLAY run rather than an error, because
 * `04` §5 invariant 1 admits no error page on the path behind the run button.
 *
 * **Returns `null` for REPLAY**, which `streamRun` spreads away entirely, so an unauthorised
 * run reaches no model code at all rather than reaching a model author that declines.
 *
 * The tally wraps `modelAuthor` rather than living inside it: `src/demo/author.ts` answers
 * "what does this agent write" and has no business knowing what a run costs, and this is the
 * one place both arms' calls pass through.
 */
function liveAuthor(event: RunEvent): { author: PatchAuthor; usage: RunUsage } | null {
  const presented = typeof event.live?.capability === 'string' ? event.live.capability : undefined;
  if (!liveCapabilityGranted(presented)) return null;

  const usage: RunUsage = {
    calls: 0,
    authored: 0,
    fellBack: 0,
    inputTokens: 0,
    outputTokens: 0,
    rejections: [],
  };

  const region = process.env['BEDROCK_REGION'];
  const base = modelAuthor({
    ...(region ? { region } : {}),
    onReject: (reason) => usage.rejections.push(reason),
  });

  const author: PatchAuthor = async (request) => {
    const result: AuthorResult = await base(request);
    if (result.usage) {
      usage.calls += 1;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
    }
    if (result.source === 'model') usage.authored += 1;
    if (result.source === 'fallback') usage.fellBack += 1;
    return result;
  };

  return { author, usage };
}

export async function handler(
  event: RunEvent,
  context: LambdaContext = {},
): Promise<{ runId: string; phase: string; undelivered: number }> {
  requireFanoutEnvironment();

  const runId = typeof event.runId === 'string' ? event.runId : null;
  const cortex = typeof event.scopes?.cortex === 'string' ? event.scopes.cortex : null;
  const naive = typeof event.scopes?.naive === 'string' ? event.scopes.naive : null;

  // Nothing validates this payload but this: it arrives from `demo.ts`, which built it from a
  // request it had already checked. A malformed one has no run id to report a failure against and
  // no scope to report it to, so there is nobody to tell and throwing is the honest end.
  if (!runId || !cortex || !naive) {
    throw new Error('runner invoked without a run id and two scopes');
  }

  const scopes: RunScopes = { cortex, naive };
  const recorders = { cortex: new StatementRecorder(), naive: new StatementRecorder() };

  const remaining = context.getRemainingTimeInMillis?.() ?? Number.POSITIVE_INFINITY;
  const budgetMs = Number.isFinite(remaining)
    ? Math.max(1_000, remaining - TERMINAL_MARGIN_MS)
    : undefined;

  // REPLAY unless this payload carries a capability that matches this function's own secret.
  // Both arms get the same author or neither does — `src/demo/run.ts` enforces that, because
  // handing the lanes different authors would make the run a comparison between two code
  // generators rather than between two coordination strategies.
  const live = liveAuthor(event);

  const outcome = await streamRun({
    runId,
    scopes,
    embed: (text) => embedder().embed(text),
    // Both scopes, so a page holding one socket sees the whole run — see `broadcast`.
    publish: async (message) => {
      await broadcast([cortex, naive], message);
    },
    recorders,
    ...(budgetMs === undefined ? {} : { budgetMs }),
    ...(live ? { author: live.author } : {}),
  });

  // Best effort and deliberately after the terminal message: the transcript is what the show-SQL
  // panel reads, and a run that ended without telling anybody it ended is the failure this unit
  // is about. `streamRun` never rejects, so this is reached on every path it can return from.
  await Promise.allSettled(
    (['cortex', 'naive'] as const).map((arm) =>
      writeSqlLog({
        sessionId: scopes[arm],
        arm,
        recordedAt: new Date().toISOString(),
        statements: recorders[arm].statements,
      }),
    ),
  );

  /**
   * **U24's metered figure leaves the deployment here and nowhere else.**
   *
   * The done-when is "one metered LIVE run exists and the cap is derived from it, not
   * estimated", and design §7.3's formula needs Bedrock's own `usage` for a whole run. This
   * line is that record for a run performed on the deployment; `npm run gate:ladder -- --meter`
   * is the same measurement taken where a human can read it directly. `costUsd` is priced at
   * the one reasoning rate this account has been billed at — see
   * `MEASURED_REASON_RATE_USD_PER_MTOK`, which explains why that is Sonnet's number.
   *
   * The capability is not in this object and must never be. It is compared and forgotten;
   * CloudWatch is a place secrets go to live for ever.
   */
  console.log(
    JSON.stringify({
      level: 'info',
      bundleRevision: BUNDLE_REVISION,
      runId,
      phase: outcome.phase,
      ms: outcome.at,
      undelivered: outcome.undelivered,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      events: outcome.arms.map((a) => ({ arm: a.arm, events: a.events.length })),
      reasoning: live
        ? {
            mode: 'live',
            ...live.usage,
            costUsd: Number(liveRunCostUsd({ at: '', ...live.usage }).toFixed(4)),
          }
        : { mode: 'replay' },
    }),
  );

  // The pool is deliberately left open. A frozen sandbox keeps `getPool`'s module-scope map, and
  // the next invocation reuses the connection — the arrangement V22 measured a 3ms warm query on.
  return { runId, phase: outcome.phase, undelivered: outcome.undelivered };
}
