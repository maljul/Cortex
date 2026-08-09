// Embeddings are on the critical path of every propose: dedupe is a distance test,
// so a wrong vector is a wrong arbitration decision, not a degraded one.
//
// Two failure modes here are silent — no exception, just a wrong answer or a larger
// bill:
//   1. Re-embedding text that has already been embedded. Nothing errors; the cost
//      and the latency simply double. This is block 14-16h's whole done-when.
//   2. A cache keyed on something other than content, so two different statements
//      collide and one agent arbitrates against another's vector.
//
// The request is asserted against the SDK's real serialisation — a captured request
// handler, not a mocked client — because the body is what Titan actually reads.
import { Readable } from 'node:stream';

import { describe, expect, test } from 'vitest';

import {
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  Embedder,
  MemoryEmbeddingCache,
  contentHash,
} from '../src/embed/titan';

/**
 * A unit vector, matching what Titan returns with `normalize: true`. Seeded by the
 * input text, so two different statements get two different vectors — without that,
 * a test asserting the cache maps distinct texts to distinct vectors would pass
 * against a stub that returns one constant.
 */
function fakeEmbedding(seed = '', dimensions = EMBED_DIMENSIONS): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const v = Array.from({ length: dimensions }, (_, i) => Math.sin(i + 1 + (h >>> 8)));
  const m = Math.hypot(...v);
  return v.map((x) => x / m);
}

/**
 * Captures the wire request the AWS SDK actually builds, and answers it locally.
 * Credentials are supplied so SigV4 signing runs — the signer sits in front of the
 * handler, so skipping it would not exercise the real path.
 */
function captureRequest(embedding?: number[]) {
  const captured: { model?: string; body?: any; calls: number } = { calls: 0 };

  const client = {
    requestHandler: {
      async handle(request: any) {
        captured.calls += 1;
        // The model id travels in the path, url-encoded.
        captured.model = decodeURIComponent(String(request.path).split('/model/')[1]?.split('/')[0] ?? '');
        captured.body = JSON.parse(String(request.body));

        const payload = JSON.stringify({
          embedding: embedding ?? fakeEmbedding(captured.body.inputText),
          inputTextTokenCount: 8,
        });
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Readable.from([Buffer.from(payload)]),
          },
        };
      },
    },
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    region: 'us-east-1',
  };

  return { captured, client };
}

function embedderWith(embedding?: number[]) {
  const { captured, client } = captureRequest(embedding);
  return { captured, embedder: new Embedder({ clientConfig: client }) };
}

describe('content hash', () => {
  test('is stable for the same text, model and dimensions', () => {
    expect(contentHash('add rate limiting', EMBED_MODEL, 1024)).toBe(
      contentHash('add rate limiting', EMBED_MODEL, 1024),
    );
  });

  test('separates text, model and dimensions', () => {
    const base = contentHash('add rate limiting', EMBED_MODEL, 1024);
    expect(contentHash('add rate limiting to login', EMBED_MODEL, 1024)).not.toBe(base);
    expect(contentHash('add rate limiting', 'amazon.titan-embed-text-v1', 1024)).not.toBe(base);
    expect(contentHash('add rate limiting', EMBED_MODEL, 512)).not.toBe(base);
  });

  // A delimiter-free concatenation would make ('ab', 'c') and ('a', 'bc') collide.
  test('does not collide when a boundary shifts between fields', () => {
    expect(contentHash('a', 'bc', 1024)).not.toBe(contentHash('ab', 'c', 1024));
  });
});

describe('request shape', () => {
  test('names the model and asks Titan for normalised 1024-dim vectors', async () => {
    const { captured, embedder } = embedderWith();
    await embedder.embed('add rate limiting to the login route');

    expect(captured.model).toBe(EMBED_MODEL);
    expect(captured.body).toEqual({
      inputText: 'add rate limiting to the login route',
      dimensions: EMBED_DIMENSIONS,
      normalize: true,
    });
  });

  // The VECTOR(1024) column would reject a short vector at insert time, far from
  // the cause. Fail where the mistake is.
  test('refuses a response whose width is not the width it asked for', async () => {
    const { embedder } = embedderWith(fakeEmbedding('anything', 512));
    await expect(embedder.embed('anything')).rejects.toThrow(/512.*1024|1024.*512/);
  });
});

describe('content-hash cache', () => {
  // Block 14-16h, done when: "repeated intent does not re-embed."
  test('a repeated intent does not re-embed', async () => {
    const { captured, embedder } = embedderWith();

    const first = await embedder.embed('add rate limiting to the login route');
    const second = await embedder.embed('add rate limiting to the login route');

    expect(captured.calls).toBe(1);
    expect(second).toEqual(first);
    expect(embedder.stats).toMatchObject({ invocations: 1, hits: 1 });
  });

  test('a different intent does re-embed', async () => {
    const { captured, embedder } = embedderWith();
    await embedder.embed('add rate limiting to the login route');
    await embedder.embed('rewrite the billing exporter');
    expect(captured.calls).toBe(2);
  });

  test('two embedders sharing a cache invoke the model once between them', async () => {
    const cache = new MemoryEmbeddingCache();
    const a = captureRequest();
    const b = captureRequest();
    const first = new Embedder({ clientConfig: a.client, cache });
    const second = new Embedder({ clientConfig: b.client, cache });

    await first.embed('migrate the accounts table');
    await second.embed('migrate the accounts table');

    expect(a.captured.calls).toBe(1);
    expect(b.captured.calls).toBe(0);
  });

  // Two agents proposing the same statement at the same instant is the normal case
  // in a fleet, not an edge case. A cache checked only after the call returns would
  // embed twice here.
  test('concurrent identical requests collapse into one invocation', async () => {
    const { captured, embedder } = embedderWith();

    const [x, y] = await Promise.all([
      embedder.embed('two agents want the same thing'),
      embedder.embed('two agents want the same thing'),
    ]);

    expect(captured.calls).toBe(1);
    expect(x).toEqual(y);
  });

  test('a failed call is not cached, so the next attempt retries it', async () => {
    let attempt = 0;
    const embedder = new Embedder({
      clientConfig: {
        requestHandler: {
          async handle() {
            attempt += 1;
            if (attempt === 1) throw new Error('bedrock is having a moment');
            return {
              response: {
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
                body: Readable.from([
                  Buffer.from(JSON.stringify({ embedding: fakeEmbedding('transient') })),
                ]),
              },
            };
          },
        },
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
      },
    });

    await expect(embedder.embed('transient')).rejects.toThrow();
    await expect(embedder.embed('transient')).resolves.toHaveLength(EMBED_DIMENSIONS);
    expect(attempt).toBe(2);
  });

  test('embedMany embeds each distinct text once and returns them in order', async () => {
    const { captured, embedder } = embedderWith();

    const vectors = await embedder.embedMany(['alpha', 'beta', 'alpha']);

    expect(captured.calls).toBe(2);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[2]);
    expect(vectors[0]).not.toEqual(vectors[1]);
  });
});

/**
 * Everything above proves the request we build. None of it proves Titan accepts it.
 *
 * That gap is this project's recurring failure mode: V1's opclass, V5's index
 * prefix and the Bedrock v5 entitlement all read as obviously fine locally and were
 * only contradicted by invoking. One live call per run is cheap insurance — Titan
 * bills fractions of a cent for eight tokens.
 */
describe('against the live Bedrock endpoint', () => {
  test('returns a unit vector of the width the schema declares', async () => {
    const embedder = new Embedder();

    const vector = await embedder.embed('add rate limiting to the login route');

    expect(vector).toHaveLength(EMBED_DIMENSIONS);
    // normalize: true. Unit vectors are what the <=> cosine ordering wants, and
    // what test/helpers/vectors.ts produces for the arbitration tests.
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    expect(embedder.stats).toEqual({ invocations: 1, hits: 0 });
  });

  test('the same statement twice costs one invocation', async () => {
    const embedder = new Embedder();

    const first = await embedder.embed('migrate the accounts table to the new shape');
    const second = await embedder.embed('migrate the accounts table to the new shape');

    expect(second).toEqual(first);
    expect(embedder.stats).toEqual({ invocations: 1, hits: 1 });
  });
});
