/**
 * RUNG 2 — spec/04-ARCHITECTURE.md §5: what the demo does when Bedrock will not embed.
 *
 * §5's ladder: "Bedrock embeddings throttled or unavailable → deterministic local hash
 * embedding, intent marked `degraded`, dedupe skipped for that intent. Database behaviour
 * fully live, dedupe degraded and labelled as such."
 *
 * **§5 singles this rung out and it is worth repeating here, at the file that implements it:**
 * "rung 2 is reachable in REPLAY as well as in LIVE. REPLAY caches reasoning, not embeddings,
 * so the demo retains a Bedrock dependency even with LIVE disabled entirely. This is the rung
 * most likely to fire unnoticed." Everything below exists so that it fires *noticeably*.
 *
 * **This produces a vector, not an embedding, and nothing here pretends otherwise.** The
 * numbers are a hash. They are the right width and the right length so they fit the column,
 * the index and the distance operator — and their distances to real embeddings mean nothing
 * whatsoever. That is the entire reason `propose()` marks the row and excludes marked rows
 * from later candidate sets: an unmarked hash vector would not merely fail to dedupe, it
 * would sit in `intents` corrupting every dedupe decision made after it, indefinitely, long
 * after Bedrock came back.
 */
import { createHash } from 'node:crypto';

import { EMBED_DIMENSIONS } from './titan.js';

export { EMBED_DIMENSIONS };

/**
 * A deterministic stand-in vector for `text`.
 *
 * SHA-256 over the text with a counter, expanded to the full width and normalised, so the
 * result is a unit vector like Titan's own output (V5 measured L2 norm 1.0 at 1024
 * dimensions). Same text in, same vector out, on any machine and in any process — §5 asks for
 * "deterministic" and a degraded run that could not be reproduced would be a degraded run
 * nobody could debug.
 *
 * Normalisation is not cosmetic: cosine distance is undefined against a zero vector, and
 * CockroachDB would be asked to compute one the moment a hash happened to cancel out.
 */
export function degradedEmbedding(text: string): number[] {
  const values: number[] = [];

  for (let block = 0; values.length < EMBED_DIMENSIONS; block += 1) {
    const digest = createHash('sha256').update(`${block}\n${text}`).digest();
    for (const byte of digest) {
      if (values.length === EMBED_DIMENSIONS) break;
      // Centre on zero so the vector points somewhere rather than into one orthant.
      values.push((byte - 127.5) / 127.5);
    }
  }

  const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
  /* c8 ignore next */
  if (norm === 0) return values.map((_, i) => (i === 0 ? 1 : 0));
  return values.map((x) => x / norm);
}

/**
 * Whether this failure is Bedrock being throttled or down, as opposed to this repository
 * being wrong.
 *
 * The boundary is deliberate and it is the interesting decision in this file. §5's rung 2 is
 * about a dependency being unavailable; a `TypeError` is a defect, and degrading quietly
 * around a defect would hide it behind a banner reading "everything else is live". Rung 4 is
 * the catch-all that keeps the page up when something genuinely unforeseen happens, and rung
 * 4's whole point is that it says nothing is live. Silently widening rung 2 would take that
 * honesty away from rung 4.
 *
 * Matched on the SDK's error names, on the HTTP status the service actually returned, and on
 * Node's socket-level codes — a Bedrock endpoint that times out is unavailable by any
 * reasonable reading, and it never gets far enough to produce a named exception.
 */
export function isEmbeddingUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const failure = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  if (
    failure.name === 'ThrottlingException' ||
    failure.name === 'TooManyRequestsException' ||
    failure.name === 'ServiceUnavailableException' ||
    failure.name === 'ModelNotReadyException' ||
    failure.name === 'ModelTimeoutException' ||
    failure.name === 'InternalServerException' ||
    failure.name === 'TimeoutError'
  ) {
    return true;
  }

  const status = failure.$metadata?.httpStatusCode;
  if (status === 429 || status === 503 || status === 500 || status === 504) return true;

  return (
    failure.code === 'ETIMEDOUT' ||
    failure.code === 'ECONNRESET' ||
    failure.code === 'ECONNREFUSED' ||
    failure.code === 'EAI_AGAIN' ||
    failure.code === 'ENOTFOUND'
  );
}

export interface MaybeDegraded {
  embedding: number[];
  /** True when this vector is a hash. The caller must carry it into `propose()`. */
  degraded: boolean;
}

/**
 * Wraps an embedder so that an unavailable Bedrock degrades instead of failing.
 *
 * Returns the degraded flag rather than hiding it, because every caller has to do something
 * with it: `propose()` needs it to skip dedupe and mark the row, and the page needs it to say
 * which of `04` §5's rungs it is standing on. An embedder that silently substituted a hash
 * would satisfy rung 2's first clause and quietly break its second and third — and it would
 * be indistinguishable from a healthy run, which is what "fires unnoticed" means.
 *
 * There is no retry here on purpose. `03` §5's retry helper is for 40001s against the
 * cluster; a throttled Bedrock wants backoff at a different timescale, and the visitor is
 * waiting behind a button. Degrading immediately and saying so beats a page that hangs.
 */
export function withDegradedFallback(
  embed: (text: string) => Promise<number[]>,
): (text: string) => Promise<MaybeDegraded> {
  return async (text: string): Promise<MaybeDegraded> => {
    try {
      return { embedding: await embed(text), degraded: false };
    } catch (error) {
      if (!isEmbeddingUnavailable(error)) throw error;
      return { embedding: degradedEmbedding(text), degraded: true };
    }
  };
}
