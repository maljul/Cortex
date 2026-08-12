/**
 * The recall sweep's ground truth. spec/03-MEMORY-MODEL.md §4.1, docs/SPEC-DELTA.md, V33.
 *
 * `bench/recall-truth.json` is the labelled corpus `npm run sweep:recall` scores against,
 * and its whole value rests on two properties that a JSON file cannot enforce about itself:
 * the grid is **total** — every query/finding cell is decided, so a loose threshold cannot
 * win by being vague — and the ids actually resolve. A typo in a `relevant` id does not
 * error at read time; it silently demotes a declared positive to a declared negative and
 * quietly *improves* the precision column. That is a corpus lying in the direction of the
 * result someone wants, which is exactly what `06` §3 exists to catch.
 *
 * The structural half is here rather than only in the script because the script is run by
 * hand and the suite is run by CI. Nothing in this file touches the cluster or Bedrock; the
 * measured half lives in the published sweep.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_DISTANCE } from '../src/memory/recall.js';

const TRUTH_PATH = fileURLToPath(new URL('../bench/recall-truth.json', import.meta.url));
const RESULTS_ROOT = fileURLToPath(new URL('../bench/results/', import.meta.url));

/**
 * The one published results directory, discovered rather than hardcoded — `bench:results`
 * names its output by timestamp, so a literal path here would break on every republish.
 * Requiring exactly one also makes CLAUDE.md's "one results directory only" a test rather
 * than a note: two published tables is a reader guessing which one is quoted.
 */
function resultsDir(): string {
  const dirs = readdirSync(RESULTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(dirs, 'exactly one results directory may be published').toHaveLength(1);
  return join(RESULTS_ROOT, dirs[0]!);
}

interface Finding {
  id: string;
  from: string;
  fact: string;
}
interface Query {
  id: string;
  task: string;
  statement: string;
  relevant: string[];
  arguable: string[];
  why: string;
}

const truth = JSON.parse(readFileSync(TRUTH_PATH, 'utf8')) as {
  findings: Finding[];
  queries: Query[];
};

describe('bench/recall-truth.json — structure', () => {
  it('gives every finding a distinct id', () => {
    const ids = truth.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every query a distinct id', () => {
    const ids = truth.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('states every finding exactly once, so no cell is degenerate', () => {
    const facts = truth.findings.map((f) => f.fact);
    expect(new Set(facts).size).toBe(facts.length);
  });

  // The failure this guards is silent and self-serving: an unresolvable id becomes a
  // declared negative and raises precision.
  it('resolves every id named in relevant or arguable', () => {
    const known = new Set(truth.findings.map((f) => f.id));
    for (const query of truth.queries) {
      for (const id of [...query.relevant, ...query.arguable]) {
        expect(known, `${query.id} names ${id}`).toContain(id);
      }
    }
  });

  it('declares at least one relevant finding per query', () => {
    // A query with no declared positive can never be "served" and would drag the
    // headline column down for a reason that has nothing to do with the threshold.
    for (const query of truth.queries) {
      expect(query.relevant.length, query.id).toBeGreaterThan(0);
    }
  });

  it('leaves declared negatives in every query, so the grid is not all-positive', () => {
    for (const query of truth.queries) {
      expect(query.relevant.length, query.id).toBeLessThan(truth.findings.length);
    }
  });

  it('records why each call was made', () => {
    for (const query of truth.queries) {
      expect(query.why.length, query.id).toBeGreaterThan(40);
    }
  });

  it('keeps the arguable set honest — a subset of the findings, not of the positives', () => {
    // `arguable` names debatable cells in *either* direction, so it must be allowed to
    // contain ids that are not in `relevant`. This asserts that freedom is actually used,
    // because an arguable list that only ever mirrored `relevant` would make the
    // sensitivity analysis one-sided.
    const refusedButArguable = truth.queries.flatMap((q) =>
      q.arguable.filter((id) => !q.relevant.includes(id)),
    );
    expect(refusedButArguable.length).toBeGreaterThan(0);
  });
});

describe('the published sweep covers the constant that ships', () => {
  it('has a row for the current DEFAULT_MAX_DISTANCE', () => {
    // Not an assertion that the constant is 0.35 — it is expected to change, and pinning
    // the value here would make closing `03` §4.1 fail the suite. What must hold is that
    // whatever value ships, the published table has a line for it. Moving the constant
    // without re-running `npm run sweep:recall` leaves a document that no longer describes
    // what the code does, and that is the failure worth catching.
    const sweep = readFileSync(join(resultsDir(), 'recall-threshold-sweep.md'), 'utf8');
    const row = new RegExp(`^\\|\\s*${DEFAULT_MAX_DISTANCE.toFixed(2)}\\s*\\|`, 'm');
    expect(
      sweep,
      `no row for ${DEFAULT_MAX_DISTANCE.toFixed(2)} — re-run npm run sweep:recall`,
    ).toMatch(row);
  });
});
