/**
 * Recorded model interactions. spec/06-BENCHMARK-SPEC.md §5.
 *
 * §5: "Model interactions are recorded to cassettes in `bench/cassettes/`, keyed by a
 * hash of the prompt. `bench` replays them by default. `--record` re-records against
 * Bedrock." Both arms consume the same cassettes, which is what makes any difference
 * in the results attributable to the coordination layer and nothing else.
 *
 * A miss in replay mode is an **error**, never a silent fall-through to Bedrock. If a
 * miss quietly reached the network, a replay run would produce numbers partly from
 * live sampling and would still call itself deterministic — and nobody would find out,
 * because the only visible symptom is a slightly slower run. That is why `get` on the
 * embedding cache throws rather than returning `undefined`: the `EmbeddingCache`
 * contract reads a miss as "go and embed it", so returning `undefined` here would be
 * precisely the silent fall-through.
 *
 * Cassettes are committed. §5's first bullet is that verifying the numbers requires no
 * setup at all, and a cassette that is not in the repository is a promise rather than
 * a recording.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { EmbeddingCache } from '../src/embed/titan.js';

export type CassetteMode = 'replay' | 'record';

export class CassetteMiss extends Error {}

/** Where the committed cassettes live. */
export const CASSETTE_DIR = new URL('./cassettes/', import.meta.url);

/** The cassette key for a reasoning call: the model and the prompt, nothing else. */
export function reasonKey(model: string, prompt: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex');
}

interface ReasonEntry<T> {
  model: string;
  /** Stored in full so a reader can audit what the model was actually asked. */
  prompt: string;
  result: T;
}

interface EmbedEntry {
  /** The text embedded. The key already covers model and width (`contentHash`). */
  text: string;
  vector: number[];
}

export class CassetteStore {
  readonly mode: CassetteMode;

  private readonly root: string;
  private readonly reasonUsed = new Set<string>();
  private readonly embedUsed = new Set<string>();
  private written = 0;

  constructor(mode: CassetteMode, dir: URL = CASSETTE_DIR) {
    this.mode = mode;
    this.root = fileURLToPath(dir);
  }

  /** Sorted so two runs' key lists compare directly. */
  get keys(): { reason: string[]; embed: string[] } {
    return {
      reason: [...this.reasonUsed].sort(),
      embed: [...this.embedUsed].sort(),
    };
  }

  get writes(): number {
    return this.written;
  }

  /**
   * Replays the recorded reasoning for `prompt`, or records it.
   *
   * `produce` is only ever called in record mode, so a replay run cannot reach the
   * network through this path even if a caller passes a live producer.
   */
  async reason<T>(model: string, prompt: string, produce: () => Promise<T>): Promise<T> {
    const key = reasonKey(model, prompt);
    const path = this.pathFor('reason', key);
    this.reasonUsed.add(key);

    if (this.mode === 'replay') {
      if (!existsSync(path)) {
        throw new CassetteMiss(
          `no reasoning cassette for ${key} (model ${model}). Replay does not fall back ` +
            'to Bedrock: re-record with `npm run bench -- --record`. A missing cassette ' +
            'usually means a bench fixture or task statement changed, which changes the ' +
            'prompt and therefore the key.',
        );
      }
      return (JSON.parse(readFileSync(path, 'utf8')) as ReasonEntry<T>).result;
    }

    const result = await produce();
    this.write(path, { model, prompt, result } satisfies ReasonEntry<T>);
    return result;
  }

  /**
   * An `EmbeddingCache` backed by the cassette directory.
   *
   * This is the seam `src/embed/titan.ts` documents: the cache is injected rather than
   * imported so the benchmark can choose a lifetime. Here the lifetime is "the
   * repository", which is what makes a replay run need no AWS credentials at all.
   */
  embeddingCache(): EmbeddingCache {
    return {
      get: (key: string): number[] | undefined => {
        const path = this.pathFor('embed', key);
        this.embedUsed.add(key);

        if (this.mode === 'record') return undefined; // fall through to Bedrock, then set()

        if (!existsSync(path)) {
          throw new CassetteMiss(
            `no embedding cassette for ${key}. Replay does not fall back to Bedrock: ` +
              're-record with `npm run bench -- --record`.',
          );
        }
        return (JSON.parse(readFileSync(path, 'utf8')) as EmbedEntry).vector;
      },

      set: (key: string, vector: number[]): void => {
        if (this.mode !== 'record') return;
        this.write(this.pathFor('embed', key), { text: '', vector } satisfies EmbedEntry);
      },
    };
  }

  /**
   * Records the text alongside a vector already written by `set`.
   *
   * `EmbeddingCache.set` receives only the content hash, so the text has to arrive by
   * a second call. It is not load-bearing — nothing reads it — but a directory of
   * 1024-float arrays with no indication of what was embedded is unauditable, and §7
   * is about what a reader can check.
   */
  labelEmbedding(key: string, text: string): void {
    if (this.mode !== 'record') return;
    const path = this.pathFor('embed', key);
    if (!existsSync(path)) return;
    const entry = JSON.parse(readFileSync(path, 'utf8')) as EmbedEntry;
    this.write(path, { text, vector: entry.vector });
  }

  private pathFor(kind: 'reason' | 'embed', key: string): string {
    return join(this.root, kind, `${key}.json`);
  }

  private write(path: string, entry: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    this.written += 1;
  }
}
