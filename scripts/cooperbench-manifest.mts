/**
 * Builds `bench/cooperbench/manifest.json` — the pre-registered task list for experiment 1.
 *
 * **This script exists so the manifest is derived rather than curated.** The whole point of
 * committing a manifest before measuring is that nobody chose its contents; if the list were
 * hand-written, "we did not select on the result" would be a promise instead of a property.
 * Everything here is a deterministic function of one pinned upstream file.
 *
 * It is deliberately *not* a sampler. All 199 features and all 652 pairs are taken, so there is
 * no selection rule to argue about and no seed to have chosen. The blind-ordering scheme the
 * review asked for — SHA256 over a fixed salt — is still computed and committed, because it is
 * what a subset WOULD be drawn in if the full run ever proves too expensive, and publishing the
 * order in advance is what makes that fallback honest.
 *
 * What it must never read: `has_conflict`. That field is CooperBench's own label for whether two
 * golden patches merge cleanly, and it is an outcome. Selecting or ordering on it would be the
 * exact defect this manifest exists to rule out. It is carried through to the output for use as a
 * secondary stratification at analysis time, and it touches nothing about which rows are included
 * or in what order.
 *
 * Usage: `npx tsx scripts/cooperbench-manifest.mts [--check]`
 *   --check  rebuild and diff against the committed manifest, exit 1 if they differ
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Pinned. A 0.0.x dataset that moves under the experiment invalidates the pre-registration. */
const DATASET = {
  repo: 'CooperBench/cooperbench-dataset',
  revision: '99dfd13988fc32ed90ac3fc41b803dfc3361039e',
  file: 'gold_conflict_report.json',
  sha256: '747b27d0e80d6442d3a7b749da3b82370868ef873c54fe09a557289820c3821e',
} as const;

/** The salt is fixed and published. Changing it reorders everything, which is why it is here. */
const BLIND_SALT = 'cortex-20260817';

interface GoldRecord {
  repo: string;
  task_id: number;
  f1: number;
  f2: number;
  has_conflict: boolean;
  patch1_apply_failed: boolean;
  patch2_apply_failed: boolean;
  error: string | null;
}

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'bench/cooperbench/gold_conflict_report.json');
const OUT = resolve(ROOT, 'bench/cooperbench/manifest.json');

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function featureId(record: { repo: string; task_id: number }, feature: number): string {
  return `${record.repo}/task${record.task_id}/feature${feature}`;
}

function poolId(record: { repo: string; task_id: number }): string {
  return `${record.repo}/task${record.task_id}`;
}

function build(): string {
  if (!existsSync(SOURCE)) {
    throw new Error(
      `${SOURCE} is missing. Fetch it first:\n` +
        `  curl -sSL -o bench/cooperbench/gold_conflict_report.json \\\n` +
        `    https://huggingface.co/datasets/${DATASET.repo}/resolve/${DATASET.revision}/${DATASET.file}`,
    );
  }
  const raw = readFileSync(SOURCE, 'utf8');
  const actual = sha256(raw);
  if (actual !== DATASET.sha256) {
    throw new Error(
      `${DATASET.file} does not match the pinned hash.\n` +
        `  expected ${DATASET.sha256}\n  actual   ${actual}\n` +
        'The upstream dataset moved. Do NOT silently re-pin: a manifest built on different data ' +
        'is a different pre-registration, and it needs a new one rather than an edit.',
    );
  }

  const report = JSON.parse(raw) as { summary: Record<string, unknown>; all_results: GoldRecord[] };
  const records = report.all_results;

  // Features, ordered by their natural identity so the list is stable without a sort key we chose.
  const features = new Map<string, { id: string; pool: string; repo: string }>();
  for (const record of records) {
    for (const f of [record.f1, record.f2]) {
      const id = featureId(record, f);
      if (!features.has(id)) {
        features.set(id, { id, pool: poolId(record), repo: record.repo });
      }
    }
  }
  const featureList = [...features.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Pairs. `blindRank` is computed from identity alone — never from has_conflict.
  const pairs = records.map((record) => {
    const a = featureId(record, record.f1);
    const b = featureId(record, record.f2);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return {
      pool: poolId(record),
      repo: record.repo,
      a: lo,
      b: hi,
      blindScore: sha256(`${BLIND_SALT}${lo}|${hi}`),
      // Carried for stratification at analysis time. Not used for inclusion or ordering.
      upstreamGoldPatchesConflict: record.has_conflict,
    };
  });
  pairs.sort((x, y) => (x.blindScore < y.blindScore ? -1 : x.blindScore > y.blindScore ? 1 : 0));

  const pools = [...new Set(pairs.map((p) => p.pool))].sort();

  const manifest = {
    $comment:
      'Pre-registered task list for experiment 1. Built by scripts/cooperbench-manifest.mts ' +
      'from a pinned upstream file. Nothing here was chosen by hand and nothing is ordered by ' +
      'an outcome. See bench/cooperbench/PREREGISTRATION.md.',
    dataset: DATASET,
    blindSalt: BLIND_SALT,
    upstreamSummary: report.summary,
    counts: {
      features: featureList.length,
      pairs: pairs.length,
      pools: pools.length,
      repos: [...new Set(featureList.map((f) => f.repo))].length,
    },
    pools,
    features: featureList.map((f) => ({ id: f.id, pool: f.pool })),
    pairs: pairs.map((p) => ({
      pool: p.pool,
      a: p.a,
      b: p.b,
      blindRankKey: p.blindScore.slice(0, 16),
      upstreamGoldPatchesConflict: p.upstreamGoldPatchesConflict,
    })),
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const built = build();

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error(`missing ${OUT} — run without --check to build it`);
    process.exit(1);
  }
  const committed = readFileSync(OUT, 'utf8');
  if (committed !== built) {
    console.error('manifest.json does not match what this script builds from the pinned source.');
    process.exit(1);
  }
  console.log(`manifest matches — sha256 ${sha256(committed)}`);
} else {
  mkdirSync(resolve(ROOT, 'bench/cooperbench'), { recursive: true });
  writeFileSync(OUT, built, 'utf8');
  const parsed = JSON.parse(built) as { counts: Record<string, number> };
  console.log(`written: ${OUT}`);
  console.log(`  ${JSON.stringify(parsed.counts)}`);
  console.log(`  sha256 ${sha256(built)}`);
}
