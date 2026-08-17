/**
 * The experiment-1 pre-registration and its manifest.
 *
 * A pre-registration is worth exactly what its timestamp is worth, and nothing else. So the two
 * things that could quietly destroy that value both have a check here:
 *
 *   1. **The manifest drifting from the pinned upstream file.** `scripts/cooperbench-manifest.mts
 *      --check` rebuilds it and diffs; this test runs that.
 *   2. **The document drifting from the manifest.** `PREREGISTRATION.md` quotes counts and a
 *      sha256. If someone regenerates the manifest and leaves the prose, the document describes a
 *      task list that is not the one committed — which is the corrected-source-and-stale-copy
 *      shape V57 found in the published benchmark summary, arriving somewhere new.
 *
 * The third assertion is the one with teeth: the manifest must not be ordered by, or filtered on,
 * CooperBench's `has_conflict`. That field is an outcome. If a future edit ever sorts by it, the
 * blind ordering becomes a selection on the result and the whole artifact is worthless.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url);
const MANIFEST_TEXT = readFileSync(new URL('bench/cooperbench/manifest.json', ROOT), 'utf8');
const PREREG = readFileSync(new URL('bench/cooperbench/PREREGISTRATION.md', ROOT), 'utf8');
const BUILDER = readFileSync(new URL('scripts/cooperbench-manifest.mts', ROOT), 'utf8');

interface Manifest {
  dataset: { revision: string; sha256: string };
  blindSalt: string;
  counts: { features: number; pairs: number; pools: number; repos: number };
  pools: string[];
  features: { id: string; pool: string }[];
  pairs: { pool: string; a: string; b: string; blindRankKey: string; upstreamGoldPatchesConflict: boolean }[];
}

const MANIFEST = JSON.parse(MANIFEST_TEXT) as Manifest;

describe('the manifest is derived from the pinned upstream file, not curated', () => {
  it('rebuilds byte-for-byte from the pinned source', () => {
    // Throws (non-zero exit) if the rebuild differs or the upstream hash moved.
    const out = execFileSync('npx', ['tsx', 'scripts/cooperbench-manifest.mts', '--check'], {
      cwd: new URL('.', ROOT).pathname,
      encoding: 'utf8',
    });
    expect(out).toContain('manifest matches');
  });

  it('takes every feature and every pair, so there is no sampling rule to argue with', () => {
    expect(MANIFEST.counts.features).toBe(MANIFEST.features.length);
    expect(MANIFEST.counts.pairs).toBe(MANIFEST.pairs.length);
    expect(MANIFEST.counts.pools).toBe(MANIFEST.pools.length);
    expect(MANIFEST.counts.pairs).toBe(652);
    expect(MANIFEST.counts.features).toBe(199);
    expect(MANIFEST.counts.pools).toBe(30);
  });

  it('every pair names two DIFFERENT features from ONE pool', () => {
    for (const pair of MANIFEST.pairs) {
      expect(pair.a).not.toBe(pair.b);
      expect(pair.a.startsWith(pair.pool)).toBe(true);
      expect(pair.b.startsWith(pair.pool)).toBe(true);
    }
  });

  it('is ordered by the published blind key and by nothing else', () => {
    const keys = MANIFEST.pairs.map((pair) => pair.blindRankKey);
    expect([...keys].sort()).toEqual(keys);
  });

  /**
   * The one that matters. `has_conflict` is CooperBench's outcome label; ordering or filtering on
   * it would make the manifest a selection on the result.
   */
  it('does not order on the upstream outcome label', () => {
    const flags = MANIFEST.pairs.map((pair) => pair.upstreamGoldPatchesConflict);
    const allTrueFirst = [...flags].sort((a, b) => Number(b) - Number(a));
    expect(flags).not.toEqual(allTrueFirst);
    // And both classes are present throughout, not segregated into the head and tail.
    const firstHundred = flags.slice(0, 100);
    expect(firstHundred).toContain(true);
    expect(firstHundred).toContain(false);
  });

  it('the builder never reads has_conflict into a sort or a filter', () => {
    // It may be read once, to carry the field through. It may not reach a comparator.
    expect(BUILDER).not.toMatch(/sort\([^)]*has_conflict/);
    expect(BUILDER).not.toMatch(/filter\([^)]*has_conflict/);
    expect(BUILDER).toMatch(/Not used for inclusion or ordering/);
  });
});

describe('the pre-registration describes the manifest that is committed', () => {
  it('quotes the manifest hash that the committed file actually has', () => {
    const digest = createHash('sha256').update(MANIFEST_TEXT).digest('hex');
    expect(PREREG).toContain(digest);
  });

  it('quotes the counts the manifest actually carries', () => {
    expect(PREREG).toContain(`${MANIFEST.counts.features} features`);
    expect(PREREG).toContain(`${MANIFEST.counts.pairs} pairs`);
    expect(PREREG).toContain(`**${MANIFEST.counts.pools} pools**`);
  });

  it('pins the same upstream revision and salt the builder does', () => {
    expect(PREREG).toContain(MANIFEST.dataset.revision);
    expect(PREREG).toContain(MANIFEST.blindSalt);
  });

  it('states acceptance thresholds and falsifiers before any result exists', () => {
    expect(PREREG).toMatch(/materially unsafe/);
    expect(PREREG).toMatch(/What would falsify the claim/);
    expect(PREREG).toMatch(/q\* = f \/ \(r \+ f\)/);
  });

  it('separates the paper figure from the reproducible one', () => {
    expect(PREREG).toContain('77.3%');
    expect(PREREG).toContain('76.5%');
  });

  it('carries no result — this document predates every measurement', () => {
    expect(PREREG).toMatch(/Nothing in this file has been measured/);
  });
});
