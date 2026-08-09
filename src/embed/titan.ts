/**
 * Embeddings via Amazon Titan Text Embeddings V2 on Bedrock.
 * spec/08-BUILD-PLAN.md §3 block 14–16h; spec/05-INTERFACES.md §6.
 *
 * This sits on the critical path of every propose. Dedupe is a distance test
 * (spec/03-MEMORY-MODEL.md §4.2), so a wrong vector is not a degraded arbitration
 * decision, it is an incorrect one — an agent either duplicates work it should have
 * adopted, or adopts an outcome from unrelated work.
 *
 * Verified against the live endpoint on 2026-08-09, `us-east-1`: the model accepts
 * `dimensions` and `normalize`, and with `normalize: true` returns unit vectors
 * (measured L2 norm 1.0), which is what the `<=>` cosine ordering wants. See
 * docs/verification-log.md.
 *
 * Do not reach for a v5 reasoning model here or anywhere else in this account —
 * `anthropic.claude-sonnet-5` and `anthropic.claude-opus-5` are listed in the
 * Bedrock catalogue but are not entitled, and a catalogue listing is not an
 * entitlement. Same log entry.
 */
import { createHash } from 'node:crypto';

import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export const EMBED_MODEL = 'amazon.titan-embed-text-v2:0';

/** Must match `VECTOR(1024)` on `intents.embedding` and `findings.embedding`. */
export const EMBED_DIMENSIONS = 1024;

export class EmbeddingError extends Error {}

/**
 * A store of vectors by content hash. Injected rather than imported so the CLI, the
 * benchmark runner and the demo can each choose a lifetime.
 *
 * The default below is per-process. That satisfies "a repeated intent does not
 * re-embed" for a single agent and for the five-agent benchmark runner, which share
 * a process. A fleet spread across machines would want a shared store — that needs
 * a table, `spec/03-MEMORY-MODEL.md` §2 does not define one, and inventing schema is
 * not this unit's scope. Implement this interface against the database when it is.
 */
export interface EmbeddingCache {
  get(key: string): Promise<number[] | undefined> | number[] | undefined;
  set(key: string, vector: number[]): Promise<void> | void;
}

export class MemoryEmbeddingCache implements EmbeddingCache {
  private readonly entries = new Map<string, number[]>();

  get(key: string): number[] | undefined {
    return this.entries.get(key);
  }

  set(key: string, vector: number[]): void {
    this.entries.set(key, vector);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The cache key. Content, model and width, newline-separated.
 *
 * The separators are load-bearing: concatenated without them, a text ending in `ab`
 * under model `c` would hash identically to one ending in `a` under model `bc`, and
 * a collision here hands one agent another's vector. Model and width are in the key
 * because the same sentence embedded at 512 dimensions, or by a future model, is a
 * different vector that must not be served from this entry.
 */
export function contentHash(text: string, model: string, dimensions: number): string {
  return createHash('sha256').update(`${model}\n${dimensions}\n${text}`).digest('hex');
}

export interface EmbedderOptions {
  model?: string;
  dimensions?: number;
  cache?: EmbeddingCache;
  /** Passed to `BedrockRuntimeClient`. Region defaults to `BEDROCK_REGION`. */
  clientConfig?: BedrockRuntimeClientConfig;
}

export interface EmbedderStats {
  /** Calls that reached Bedrock. */
  invocations: number;
  /** Calls served from the cache. The demo shows this; it is the unit's whole point. */
  hits: number;
}

/**
 * Embeds text, once per distinct string.
 *
 * Three layers of not-re-embedding, in order: the cache, the in-flight map, and
 * within-batch deduplication in `embedMany`. The in-flight map is the one that is
 * easy to leave out and expensive to lack — two agents proposing the same statement
 * at the same instant is the normal case in a fleet, and a cache consulted only
 * after the call returns would embed both.
 */
export class Embedder {
  readonly model: string;
  readonly dimensions: number;

  private readonly client: BedrockRuntimeClient;
  private readonly cache: EmbeddingCache;
  private readonly inFlight = new Map<string, Promise<number[]>>();
  private invocations = 0;
  private hits = 0;

  constructor(options: EmbedderOptions = {}) {
    // spec/05-INTERFACES.md §6 names BEDROCK_EMBED_MODEL as configuration, so it is
    // honoured here rather than only in the CLI.
    this.model = options.model ?? process.env.BEDROCK_EMBED_MODEL ?? EMBED_MODEL;
    this.dimensions = options.dimensions ?? EMBED_DIMENSIONS;
    this.cache = options.cache ?? new MemoryEmbeddingCache();
    // Omitted rather than passed as undefined, which `exactOptionalPropertyTypes`
    // rejects. Runtime behaviour is unchanged: the SDK resolves
    // `config?.region ?? loadNodeConfig(NODE_REGION_CONFIG_OPTIONS)`, and `??`
    // treats an absent key and an explicitly undefined one the same way.
    const region = process.env.BEDROCK_REGION;
    this.client = new BedrockRuntimeClient({
      ...(region === undefined ? {} : { region }),
      ...options.clientConfig,
    });
  }

  get stats(): EmbedderStats {
    return { invocations: this.invocations, hits: this.hits };
  }

  async embed(text: string): Promise<number[]> {
    const key = contentHash(text, this.model, this.dimensions);

    const cached = await this.cache.get(key);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.hits += 1;
      return pending;
    }

    const call = this.invoke(text)
      .then(async (vector) => {
        await this.cache.set(key, vector);
        return vector;
      })
      // A failure must not be cached, and must not leave a rejected promise parked
      // in the map for every later caller to inherit.
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, call);
    return call;
  }

  /** Embeds a batch, invoking once per distinct string and returning input order. */
  async embedMany(texts: readonly string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }

  private async invoke(text: string): Promise<number[]> {
    this.invocations += 1;

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: text,
          dimensions: this.dimensions,
          normalize: true,
        }),
      }),
    );

    const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding?: unknown;
    };

    if (!Array.isArray(payload.embedding)) {
      throw new EmbeddingError(`${this.model} returned no embedding array`);
    }

    // Width drift is silent downstream: a short vector is rejected by the
    // VECTOR(1024) column at insert time, which surfaces the mistake a long way
    // from its cause. Fail here instead.
    if (payload.embedding.length !== this.dimensions) {
      throw new EmbeddingError(
        `${this.model} returned ${payload.embedding.length} dimensions, expected ${this.dimensions}`,
      );
    }

    return payload.embedding as number[];
  }
}
