/**
 * The offline duplicate judge. spec/06-BENCHMARK-SPEC.md §3.
 *
 * §3: "`duplicate_work_rate` MUST be computed by an offline judge that does not share
 * code with the dedupe path. Measuring a mechanism with itself is the most common way
 * benchmarks like this become worthless, and a database-company judge will look for
 * it."
 *
 * So this module imports **nothing from `src/`** — not the threshold in
 * `propose.ts`, not the SQL that computes `<=>`, not the `Embedder`. A test greps the
 * import list and fails if any of them appear, because the rule is easy to honour
 * today and easy to break in six months with an innocent-looking convenience import.
 *
 * What it does share is the *input*: the same recorded vectors both arms were given.
 * That is not the mechanism, it is the corpus — refusing to reuse the embeddings would
 * mean judging equivalence with a second, differently-trained notion of meaning, and
 * then a disagreement between judge and mechanism would tell you nothing about either.
 * The distance function below is this file's own, and the threshold is this file's own.
 *
 * Ground truth for the sweep is the `pair` label in `bench/tasks.json`, written by hand
 * before anything was measured (U11) — not by clustering the corpus, which would be the
 * same circularity one level up.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { pairs, TASKS } from './tasks.js';

/** Where `--record` writes the embedding cassettes. Read directly; no embedder involved. */
const EMBED_DIR = new URL('./cassettes/embed/', import.meta.url);

/**
 * The judge's own cosine distance.
 *
 * Deliberately not imported from anywhere. It is four lines, and the alternative is a
 * shared helper that someone later "simplifies" into the one the mechanism uses.
 */
export function judgeDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SweepRow {
  threshold: number;
  /** Declared pairs the threshold catches. */
  truePositives: number;
  /** Undeclared pairs it also catches — the expensive mistake. */
  falsePositives: number;
  precision: number;
  recall: number;
}

export interface Separation {
  /** The furthest-apart declared pair. */
  worstDeclared: number;
  /** The closest pair that is not declared. */
  bestUndeclared: number;
}

export class DuplicateJudge {
  private readonly vectors: Map<string, number[]>;

  private constructor(vectors: Map<string, number[]>) {
    this.vectors = vectors;
  }

  /**
   * Builds the judge from the committed cassettes.
   *
   * Reading the vectors off disk rather than embedding again is what makes the judge
   * *offline* in §3's sense: it needs no credentials, so anyone can re-run it against
   * the repository alone and check the duplicate rate for themselves.
   */
  static fromCassettes(dir: URL = EMBED_DIR): DuplicateJudge {
    const root = fileURLToPath(dir);
    const byText = new Map<string, number[]>();

    for (const name of readdirSync(root).sort()) {
      if (!name.endsWith('.json')) continue;
      const entry = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
        text: string;
        vector: number[];
      };
      if (entry.text !== '') byText.set(entry.text, entry.vector);
    }

    const vectors = new Map<string, number[]>();
    for (const task of TASKS) {
      const vector = byText.get(task.statement);
      if (vector !== undefined) vectors.set(task.id, vector);
    }

    return new DuplicateJudge(vectors);
  }

  /** Tasks with no recorded vector. Non-empty means the cassettes are incomplete. */
  missing(): string[] {
    return TASKS.filter((task) => !this.vectors.has(task.id)).map((task) => task.id);
  }

  distance(a: string, b: string): number {
    const va = this.vectors.get(a);
    const vb = this.vectors.get(b);
    if (va === undefined || vb === undefined) {
      throw new Error(`no recorded vector for ${va === undefined ? a : b}`);
    }
    return judgeDistance(va, vb);
  }

  /**
   * Which of `completedInOrder` duplicate work an *earlier* entry already did.
   *
   * Order matters and is the caller's: §3 says "semantically equivalent to an **earlier**
   * completed intent", so the first of a pair is work that genuinely needed doing and
   * only the second is waste. Counting both would double the rate and make the ceiling
   * 2× the redundant share rather than 1×.
   */
  duplicatesAmong(completedInOrder: readonly string[], threshold: number): Set<string> {
    const duplicates = new Set<string>();
    const seen: string[] = [];

    for (const taskId of completedInOrder) {
      if (!this.vectors.has(taskId)) continue;
      if (seen.some((earlier) => this.distance(earlier, taskId) < threshold)) {
        duplicates.add(taskId);
      }
      seen.push(taskId);
    }

    return duplicates;
  }

  /** Every unordered pair of tasks that has a vector, with its distance. */
  private allPairs(): Array<{ a: string; b: string; distance: number; declared: boolean }> {
    const declared = new Set<string>();
    for (const members of pairs().values()) {
      for (const one of members) {
        for (const other of members) {
          if (one.id !== other.id) declared.add([one.id, other.id].sort().join('|'));
        }
      }
    }

    const ids = [...this.vectors.keys()].sort();
    const out: Array<{ a: string; b: string; distance: number; declared: boolean }> = [];

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = ids[i]!;
        const b = ids[j]!;
        out.push({
          a,
          b,
          distance: this.distance(a, b),
          declared: declared.has([a, b].sort().join('|')),
        });
      }
    }

    return out;
  }

  /**
   * The gap the corpus has to have. U11 measured it before this existed; this is the
   * same measurement taken by the judge's own distance function, which is the one the
   * published rate is computed with.
   */
  separation(): Separation {
    const all = this.allPairs();
    return {
      worstDeclared: Math.max(...all.filter((p) => p.declared).map((p) => p.distance)),
      bestUndeclared: Math.min(...all.filter((p) => !p.declared).map((p) => p.distance)),
    };
  }

  /**
   * Precision and recall against the declared pairs, per threshold. §6's
   * `threshold-sweep.md`.
   *
   * Precision is the one that costs something. A false positive means the CORTEX arm
   * skipped work that genuinely needed doing and booked the skip as a saving, so a
   * threshold that buys recall at the cost of precision makes the headline number
   * better and the system worse.
   */
  sweep(thresholds: readonly number[]): SweepRow[] {
    const all = this.allPairs();
    const declaredCount = all.filter((p) => p.declared).length;

    return thresholds.map((threshold) => {
      const caught = all.filter((p) => p.distance < threshold);
      const truePositives = caught.filter((p) => p.declared).length;
      const falsePositives = caught.length - truePositives;

      return {
        threshold,
        truePositives,
        falsePositives,
        precision: caught.length === 0 ? 1 : truePositives / caught.length,
        recall: declaredCount === 0 ? 0 : truePositives / declaredCount,
      };
    });
  }
}
