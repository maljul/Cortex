/**
 * The deployment's Bedrock configuration is pinned to `.env`.
 *
 * `infra/cdk/lib/cortex-stack.ts` writes the region and the embedding model as literals,
 * because `cdk synth` runs from `infra/cdk/` with no `.env` loaded and a value that
 * silently defaulted would be worse than one written down. This is the guard that stops
 * the two from drifting.
 *
 * **Why drift matters here and not for most constants.** `src/embed/titan.ts` hashes the
 * model and the width into its cache key, because a sentence embedded by a different
 * model at a different width is a different vector. A deployment that consolidates
 * findings with one model while local runs recall them with another produces cosine
 * distances that mean nothing — and nothing would fail, because both sides would be
 * internally consistent. That is exactly the class of error this repository has agreed to
 * catch by checking rather than by reasoning.
 *
 * The technique is `test/skill.test.ts`'s: read the other file as text and hold it against
 * the source of truth, rather than importing it. `infra/cdk/` is a separate deployable
 * with its own module resolution and is excluded from this project's `tsconfig.json`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stackSource = readFileSync(
  fileURLToPath(new URL('../infra/cdk/lib/cortex-stack.ts', import.meta.url)),
  'utf8',
);

function literal(name: string): string | undefined {
  return new RegExp(`const ${name} = '([^']+)'`).exec(stackSource)?.[1];
}

describe('the stack embeds with the same model this repository does', () => {
  it('pins the embedding model to BEDROCK_EMBED_MODEL', () => {
    const expected = process.env['BEDROCK_EMBED_MODEL'];
    expect(expected, 'BEDROCK_EMBED_MODEL is not set in .env').toBeTruthy();
    expect(literal('embedModel')).toBe(expected);
  });

  it('pins the region to BEDROCK_REGION', () => {
    const expected = process.env['BEDROCK_REGION'];
    expect(expected, 'BEDROCK_REGION is not set in .env').toBeTruthy();
    expect(literal('bedrockRegion')).toBe(expected);
  });

  /**
   * `04` §5's brake 1 is not implementable on this account (V26), and the stack says so.
   * If a later session adds a reservation because the spec asks for one, this fails and
   * points at the measurement rather than letting the deploy fail with an AWS error
   * whose cause is three documents away.
   */
  it('carries no reserved concurrency, because this account refuses every value', () => {
    expect(stackSource).not.toMatch(/reservedConcurrentExecutions/);
  });
});
