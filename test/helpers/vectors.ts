/**
 * Deterministic test vectors.
 *
 * Dedupe is a distance test, so the tests need pairs whose cosine distance they
 * control exactly — a real embedding model would make the assertions depend on
 * Bedrock being reachable and on its output being stable, neither of which is
 * something these tests are trying to prove.
 */
import { EMBEDDING_DIMENSIONS } from '../../src/memory/propose.js';

/** mulberry32 — small, fast, and identical across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalise(v: number[]): number[] {
  const magnitude = Math.hypot(...v);
  return v.map((component) => component / magnitude);
}

/**
 * A unit vector for `seed`. Two different seeds are near-orthogonal in 1024
 * dimensions, so their cosine distance sits around 1.0 — comfortably outside any
 * sane dedupe threshold.
 */
export function vector(seed: number): number[] {
  const next = prng(seed);
  return normalise(Array.from({ length: EMBEDDING_DIMENSIONS }, () => next() * 2 - 1));
}

/**
 * A vector close to `base`, standing in for a paraphrase of the same intent.
 * `strength` is the weight of the noise: small values stay well inside the 0.28
 * dedupe threshold.
 */
export function paraphraseOf(base: readonly number[], seed: number, strength = 0.05): number[] {
  const next = prng(seed);
  return normalise(base.map((component) => component + (next() * 2 - 1) * strength));
}

/** Cosine distance, matching the `<=>` operator the schema's indexes are built for. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return 1 - dot / (Math.hypot(...a) * Math.hypot(...b));
}
