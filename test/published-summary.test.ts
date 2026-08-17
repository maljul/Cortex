/**
 * The published benchmark summary, held against the generator that writes it.
 *
 * **This test exists because of V57.** `scripts/bench-results.mts` was corrected on 2026-08-13
 * so that the reproduction prerequisites named `CORTEX_WRITER_DSN`, and the committed
 * `summary.md` was never regenerated — so the fix reached the generator and not the file
 * anybody reads. A judge configuring exactly what the published artifact asked for would have
 * watched the CORTEX arm fail. Nothing caught it for three days.
 *
 * Regenerating is not the fix: `npm run bench:results` runs both arms three times against the
 * real cluster, and the wall-clock rows would move, which is a published number moving for a
 * prose edit. So the prose is edited in both places by hand, and this test is what makes that
 * safe — it fails the moment the two disagree.
 *
 * Scope, deliberately: the *narrative* sections only. The tables, the spread and the
 * environment block are computed from a run and cannot be compared against source text.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GENERATOR = readFileSync(new URL('../scripts/bench-results.mts', import.meta.url), 'utf8');

const RESULTS_DIR = new URL('../bench/results/', import.meta.url);

/** `06` §6 and CLAUDE.md both require exactly one published directory. */
function theOneResultsDir(): string {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const entries = readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

const SUMMARY = readFileSync(new URL(`${theOneResultsDir()}/summary.md`, RESULTS_DIR), 'utf8');

/**
 * Pull the single-quoted string literals the generator emits between two markers, and join
 * them the way the generator joins them. Escaped apostrophes are the only escape in use.
 */
function generatorLines(fromMarker: string, toMarker: string): string {
  const start = GENERATOR.indexOf(fromMarker);
  const end = GENERATOR.indexOf(toMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const region = GENERATOR.slice(start, end + toMarker.length);
  const lines: string[] = [];
  for (const raw of region.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === "''," || trimmed === "''") {
      lines.push('');
      continue;
    }
    const match = /^'((?:[^'\\]|\\.)*)',?$/.exec(trimmed);
    if (match) lines.push(match[1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  expect(lines.length).toBeGreaterThan(10);
  return lines.join('\n');
}

describe('the published summary matches the generator that writes it', () => {
  it('carries the "where this mechanism loses" section byte-for-byte', () => {
    const block = generatorLines(
      "'## Where this mechanism loses',",
      "'file publishes its false positives rather than only its catches.',",
    );
    expect(SUMMARY).toContain(block);
  });

  it('carries the limitations byte-for-byte, including the three added on 2026-08-17', () => {
    const block = generatorLines(
      "'## Limitations, stated by the author',",
      "'  difference a coordination result.',",
    );
    expect(SUMMARY).toContain(block);
  });

  it('names CORTEX_WRITER_DSN as the prerequisite, which is V57 itself', () => {
    expect(SUMMARY).toContain('CORTEX_WRITER_DSN');
  });
});

describe('the narrow claim is published, not just held in a review', () => {
  it('states the break-even model rather than claiming universal advantage', () => {
    expect(SUMMARY).toMatch(/p · L > H \+ B/);
    expect(SUMMARY).toMatch(/isolation is faster/);
  });

  it('discloses that the duplicate pairs were revised after being measured', () => {
    expect(SUMMARY).toMatch(/selected conditional on the detector/);
  });

  it('says what the NAIVE arm is, so the table is not read as a worktree result', () => {
    expect(SUMMARY).toMatch(/not "worktree isolation"/);
    expect(SUMMARY).toMatch(/should not be read as one/);
  });

  it('scopes lost_writes to bytes overwritten rather than clean-merge feature loss', () => {
    expect(SUMMARY).toMatch(/`lost_writes` counts bytes actually overwritten/);
  });
});
