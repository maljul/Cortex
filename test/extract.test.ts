// Graph extraction is the highest-volume model call in CORTEX: one per episode,
// thousands of times. Both ways it can silently overbill are asserted here against
// the SDK's real serialisation — a captured fetch, not a mocked client:
//
//   1. `effort` sent as an HTTP header is ignored, and the call runs at default
//      effort. Nothing errors.
//   2. A system prefix under 512 tokens never caches. `cache_control` is accepted,
//      `cache_creation_input_tokens` stays 0, and nothing errors.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test } from 'vitest';

import {
  EXTRACTION_SYSTEM,
  MIN_CACHEABLE_PREFIX_TOKENS,
  buildExtractionRequest,
  estimatePrefixTokens,
  extractGraph,
  summarizeUsage,
} from '../src/extract/graph';

const EPISODE = {
  text: 'Agent 3 claimed src/auth/login.ts on 2026-07-14 to fix the session refresh bug.',
  occurredAt: '2026-07-14T09:30:00Z',
};

function fakeMessage(usage: Record<string, number>) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          entities: [{ name: 'agent-3', type: 'agent', description: 'fleet worker' }],
          edges: [
            {
              source: 'agent-3',
              target: 'file:src/auth/login.ts',
              relation: 'claimed',
              valid_from: '2026-07-14',
            },
          ],
        }),
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  };
}

/** Captures the wire request the SDK actually builds. No network, no API key needed. */
function captureRequest(usage: Record<string, number> = {}) {
  const captured: { body: any; headers: Headers } = { body: undefined, headers: new Headers() };

  const client = new Anthropic({
    apiKey: 'test-key-not-used',
    fetch: (async (_url: unknown, init: any) => {
      captured.headers = new Headers(init?.headers);
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(fakeMessage(usage)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  });

  return { captured, client };
}

describe('extraction request shape', () => {
  test('sends effort in the request body, never as an HTTP header', async () => {
    const { captured, client } = captureRequest();

    await extractGraph(EPISODE, { client });

    expect(captured.body.output_config.effort).toBe('low');
    // The trap: an `effort` header is accepted by any HTTP client and ignored by
    // the API, so the call silently runs at the default effort instead.
    expect(captured.headers.has('effort')).toBe(false);
  });

  test('marks the system prefix cacheable with a one-hour TTL', async () => {
    const { captured, client } = captureRequest();

    await extractGraph(EPISODE, { client });

    const lastSystemBlock = captured.body.system.at(-1);
    expect(lastSystemBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('constrains the response to the graph schema', async () => {
    const { captured, client } = captureRequest();

    await extractGraph(EPISODE, { client });

    expect(captured.body.output_config.format.type).toBe('json_schema');
  });

  test('keeps per-episode content out of the cached prefix', async () => {
    const first = buildExtractionRequest(EPISODE);
    const second = buildExtractionRequest({
      text: 'Agent 5 opened a migration for the billing table.',
      occurredAt: '2026-07-15T11:00:00Z',
    });

    // Byte-identical prefix across episodes, or the cache never hits.
    expect(JSON.stringify(first.system)).toBe(JSON.stringify(second.system));
    // The variable part must live after the prefix.
    expect(JSON.stringify(first.messages)).not.toBe(JSON.stringify(second.messages));
  });

  test('puts the reference time in the episode turn so the graph stays temporal', () => {
    const request = buildExtractionRequest(EPISODE);

    expect(JSON.stringify(request.messages)).toContain(EPISODE.occurredAt);
    expect(JSON.stringify(request.system)).not.toContain(EPISODE.occurredAt);
  });
});

describe('cacheable prefix guard', () => {
  test('the shipped extraction prompt clears the 512-token minimum', () => {
    expect(estimatePrefixTokens(EXTRACTION_SYSTEM)).toBeGreaterThanOrEqual(
      MIN_CACHEABLE_PREFIX_TOKENS,
    );
  });

  test('rejects a prefix too short to ever cache', () => {
    // Roughly the length of the prompt most write-ups ship: reads fine, caches never.
    const tooShort = 'Extract a knowledge graph from the text. Return JSON only.';

    expect(() => buildExtractionRequest(EPISODE, { system: tooShort })).toThrow(
      /512|too short|cacheable/i,
    );
  });
});

describe('usage accounting', () => {
  test('reports a cache hit when tokens were read from cache', () => {
    const usage = summarizeUsage({
      input_tokens: 210,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 640,
    });

    expect(usage.cacheHit).toBe(true);
    expect(usage.cachedTokens).toBe(640);
  });

  test('reports a miss when the prefix was too short to cache', () => {
    // The silent-failure signature: a breakpoint was sent, nothing was cached.
    const usage = summarizeUsage({
      input_tokens: 850,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    expect(usage.cacheHit).toBe(false);
    expect(usage.uncachedTokens).toBe(850);
  });

  test('surfaces usage from a real response body', async () => {
    const { client } = captureRequest({ cache_read_input_tokens: 640, input_tokens: 190 });

    const { graph, usage } = await extractGraph(EPISODE, { client });

    expect(usage.cacheHit).toBe(true);
    expect(graph.entities[0].name).toBe('agent-3');
    expect(graph.edges[0].valid_from).toBe('2026-07-14');
  });
});
