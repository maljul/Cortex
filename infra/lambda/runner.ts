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
import { streamRun, type RunScopes } from '../../src/demo/run.js';
import { writeSqlLog } from '../../src/demo/sql-log.js';
import { Embedder } from '../../src/embed/titan.js';
import { broadcast, requireFanoutEnvironment } from './fanout.js';
import { installSqlLogStore } from './sql-log-store.js';

interface RunEvent {
  runId?: unknown;
  scopes?: { cortex?: unknown; naive?: unknown };
}

/** The subset of Lambda's context this handler reads. */
interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
}

const BUNDLE_REVISION = 3;

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
    }),
  );

  // The pool is deliberately left open. A frozen sandbox keeps `getPool`'s module-scope map, and
  // the next invocation reuses the connection — the arrangement V22 measured a 3ms warm query on.
  return { runId, phase: outcome.phase, undelivered: outcome.undelivered };
}
