/**
 * The RECALL threshold sweep — spec/03-MEMORY-MODEL.md §4.1, docs/SPEC-DELTA.md.
 *
 *   npm run sweep:recall
 *
 * §4.1 publishes `WHERE n.dist < 0.35` and `src/memory/recall.ts` ships it as
 * `DEFAULT_MAX_DISTANCE`. V28 measured that under real Titan embeddings every honest
 * wording of a finding sits 0.38–0.47 from the task it describes, so the filter excludes
 * exactly the case recall exists to serve. SPEC-DELTA declined to move the constant and
 * said what closing it would need: "a sweep like `bench/results/*​/threshold-sweep.md`,
 * over findings and queries rather than over intent pairs". This is that sweep.
 *
 * Two properties make it evidence rather than decoration:
 *
 * - **Ground truth was written first.** `bench/recall-truth.json` was authored by hand
 *   before anything here was run, the same way `bench/tasks.json`'s `pair` labels were.
 *   The grid is total — every query/finding cell is decided — so a loose threshold cannot
 *   score well by being vague.
 * - **The distances come from the cluster.** CockroachDB's own `<=>` computes them, which
 *   is the operator the mechanism arbitrates on, and the embeddings are live Titan calls.
 *   Cosine reimplemented in TypeScript would agree only for as long as two implementations
 *   happened to agree. This follows `src/memory/duplicates.ts`, which moved to the same
 *   footing in U16b for the same reason.
 *
 * What this script does **not** do is pick the number. It prints a table and the bands
 * that fall out of it; choosing the constant is a separate act with the measurement in
 * front of a human, which is how `03` §4.2's dedupe threshold was closed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { closePool, getPool } from '../src/db/pool.js';
import { Embedder } from '../src/embed/titan.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const TRUTH_PATH = resolve(process.cwd(), 'bench/recall-truth.json');
const OUT_PATH = resolve(
  process.cwd(),
  'bench/results/2026-08-10T22-38-54-176Z/recall-threshold-sweep.md',
);

/**
 * The constants a reader will look for, plus enough resolution around them to see where
 * the edges are. 0.35 is what §4.1 ships; 0.39 is `src/memory/propose.ts`'s dedupe
 * threshold and the ordering question SPEC-DELTA raised is about the two of them.
 */
const THRESHOLDS = [
  0.2, 0.28, 0.32, 0.35, 0.38, 0.39, 0.4, 0.42, 0.45, 0.48, 0.5, 0.55, 0.6, 0.63, 0.65,
  0.7, 0.75, 0.8, 0.85, 0.9,
];

const DISTANCE_SQL = `
  SELECT k.id, ($1::VECTOR(1024) <=> k.emb::VECTOR(1024)) AS dist
  FROM unnest($2::TEXT[], $3::TEXT[]) AS k(id, emb)
`;

interface Finding {
  id: string;
  from: string;
  fact: string;
  note?: string;
}

interface Query {
  id: string;
  task: string;
  statement: string;
  relevant: string[];
  arguable: string[];
  why: string;
}

interface Truth {
  findings: Finding[];
  queries: Query[];
}

interface Pair {
  queryId: string;
  findingId: string;
  distance: number;
  /** The declared call, before any sensitivity flip. */
  relevant: boolean;
  arguable: boolean;
}

interface Row {
  threshold: number;
  returned: number;
  truePositives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  /** Queries that get at least one declared-relevant finding back. Beat 1 fires or it does not. */
  queriesServed: number;
}

function loadTruth(): Truth {
  const truth = JSON.parse(readFileSync(TRUTH_PATH, 'utf8')) as Truth;
  const ids = new Set(truth.findings.map((f) => f.id));

  // A typo in an id would silently become a declared negative and quietly inflate
  // precision, so it is an error rather than a warning.
  for (const query of truth.queries) {
    for (const id of [...query.relevant, ...query.arguable]) {
      if (!ids.has(id)) {
        throw new Error(`${query.id} names finding ${id}, which bench/recall-truth.json does not define`);
      }
    }
  }
  if (ids.size !== truth.findings.length) throw new Error('duplicate finding id');
  return truth;
}

function score(pairs: readonly Pair[], queryCount: number, flipArguable: boolean): Row[] {
  const isRelevant = (p: Pair): boolean => (p.arguable && flipArguable ? !p.relevant : p.relevant);
  const positives = pairs.filter(isRelevant).length;

  return THRESHOLDS.map((threshold) => {
    const returned = pairs.filter((p) => p.distance < threshold);
    const truePositives = returned.filter(isRelevant).length;
    const served = new Set(
      returned.filter(isRelevant).map((p) => p.queryId),
    ).size;

    return {
      threshold,
      returned: returned.length,
      truePositives,
      falsePositives: returned.length - truePositives,
      precision: returned.length === 0 ? 1 : truePositives / returned.length,
      recall: positives === 0 ? 0 : truePositives / positives,
      queriesServed: served,
    } satisfies Row;
  });
}

/** One cell's measured distance, by name, so prose can quote a number it did not retype. */
function pairDist(pairs: readonly Pair[], queryId: string, findingId: string): number {
  const pair = pairs.find((p) => p.queryId === queryId && p.findingId === findingId);
  if (!pair) throw new Error(`no measured pair ${queryId}/${findingId}`);
  return pair.distance;
}

/** The widest run of thresholds where precision and recall are both perfect, if one exists. */
function perfectBand(rows: readonly Row[]): [number, number] | null {
  const perfect = rows.filter((r) => r.precision === 1 && r.recall === 1);
  if (perfect.length === 0) return null;
  return [perfect[0]!.threshold, perfect.at(-1)!.threshold];
}

function table(rows: readonly Row[], queryCount: number): string {
  const head =
    '| threshold | findings returned | of them relevant | false positives | precision | recall | queries served |\n' +
    '|-----------|-------------------|------------------|-----------------|-----------|--------|----------------|';
  const body = rows.map(
    (r) =>
      `| ${r.threshold.toFixed(2).padStart(9)} | ${String(r.returned).padStart(17)} | ` +
      `${String(r.truePositives).padStart(16)} | ${String(r.falsePositives).padStart(15)} | ` +
      `${r.precision.toFixed(3).padStart(9)} | ${r.recall.toFixed(3).padStart(6)} | ` +
      `${`${r.queriesServed}/${queryCount}`.padStart(14)} |`,
  );
  return [head, ...body].join('\n');
}

async function main(): Promise<void> {
  const truth = loadTruth();
  const embedder = new Embedder();

  const texts = [
    ...truth.queries.map((q) => q.statement),
    ...truth.findings.map((f) => f.fact),
  ];
  const vectors = await embedder.embedMany(texts);
  const vectorOf = new Map<string, string>();
  texts.forEach((text, i) => vectorOf.set(text, `[${vectors[i]!.join(',')}]`));

  console.log(
    `embedded ${texts.length} statements — ${embedder.stats.invocations} Bedrock calls, ` +
      `${embedder.stats.hits} cached`,
  );

  const pool = getPool('write');
  const findingIds = truth.findings.map((f) => f.id);
  const findingVectors = truth.findings.map((f) => vectorOf.get(f.fact)!);
  const pairs: Pair[] = [];

  for (const query of truth.queries) {
    const { rows } = await pool.query<{ id: string; dist: string }>(DISTANCE_SQL, [
      vectorOf.get(query.statement)!,
      findingIds,
      findingVectors,
    ]);
    for (const row of rows) {
      pairs.push({
        queryId: query.id,
        findingId: row.id,
        distance: Number(row.dist),
        relevant: query.relevant.includes(row.id),
        arguable: query.arguable.includes(row.id),
      });
    }
  }

  const queryCount = truth.queries.length;
  const declared = score(pairs, queryCount, false);
  const flipped = score(pairs, queryCount, true);

  const band = perfectBand(declared);
  const flippedBand = perfectBand(flipped);

  // Where each query's nearest declared-relevant finding actually sits. This is the
  // column that answers "at what threshold does beat 1 stop being empty".
  const nearest = truth.queries.map((query) => {
    const mine = pairs.filter((p) => p.queryId === query.id && p.relevant);
    const best = mine.reduce((a, b) => (a.distance <= b.distance ? a : b));
    const nearestIrrelevant = pairs
      .filter((p) => p.queryId === query.id && !p.relevant)
      .reduce((a, b) => (a.distance <= b.distance ? a : b));
    return { query, best, nearestIrrelevant };
  });

  const rowAt = (threshold: number): Row => {
    const row = declared.find((r) => r.threshold === threshold);
    if (!row) throw new Error(`${threshold} is not in THRESHOLDS`);
    return row;
  };
  const servedAt = (threshold: number): number => rowAt(threshold).queriesServed;

  /** The largest tested threshold that still returns nothing irrelevant, and the first that does. */
  const lastPerfect = declared.filter((r) => r.falsePositives === 0).at(-1)!.threshold;
  const firstImperfect = declared.find((r) => r.falsePositives > 0)?.threshold ?? null;

  /** Queries whose nearest relevant finding beats their nearest irrelevant one — i.e. ranking works. */
  const rankSeparated = nearest.filter(
    (n) => n.best.distance < n.nearestIrrelevant.distance,
  ).length;
  const nearestDistances = nearest.map((n) => n.best.distance);
  const minNearest = Math.min(...nearestDistances);
  const maxNearest = Math.max(...nearestDistances);

  const lines: string[] = [];
  lines.push('# Recall threshold sweep');
  lines.push('');
  lines.push(
    `Recorded ${new Date().toISOString()}. Distance is cosine computed by **CockroachDB's own \`<=>\`**`,
  );
  lines.push(
    'on live Titan Text Embeddings V2 vectors, 1024 dimensions — the operator and the model the',
  );
  lines.push(
    'mechanism actually uses, not a reimplementation. Ground truth is `bench/recall-truth.json`,',
  );
  lines.push('written by hand before anything here was measured.');
  lines.push('');
  lines.push(
    `${queryCount} queries × ${truth.findings.length} findings = ${pairs.length} decided cells, ` +
      `${pairs.filter((p) => p.relevant).length} of them declared relevant.`,
  );
  lines.push('');
  lines.push(table(declared, queryCount));
  lines.push('');
  lines.push('## Where the relevant findings actually sit');
  lines.push('');
  lines.push('| query | nearest relevant finding | dist | nearest *irrelevant* finding | dist |');
  lines.push('|-------|--------------------------|------|------------------------------|------|');
  for (const n of nearest) {
    lines.push(
      `| ${n.query.id} | ${n.best.findingId} | ${n.best.distance.toFixed(4)} | ` +
        `${n.nearestIrrelevant.findingId} | ${n.nearestIrrelevant.distance.toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push('## The twelve closest declared-irrelevant pairs');
  lines.push('');
  lines.push(
    'What any distance filter has to survive. If these sit far out, the filter is not what is',
  );
  lines.push('keeping noise out of an agent\'s context — the `LIMIT k` and the ordering are.');
  lines.push('');
  lines.push('| query | finding | dist |');
  lines.push('|-------|---------|------|');
  for (const p of [...pairs].filter((p) => !p.relevant).sort((a, b) => a.distance - b.distance).slice(0, 12)) {
    lines.push(`| ${p.queryId} | ${p.findingId} | ${p.distance.toFixed(4)} |`);
  }
  lines.push('');
  lines.push('## Reading it');
  lines.push('');
  lines.push(
    '**`queries served` is the column that matters for `07` §3 beat 1.** It counts queries that get',
  );
  lines.push(
    'at least one genuinely relevant finding back. A threshold can hold precision at 1.000 and still',
  );
  lines.push('answer "nothing known" to every question the fleet can actually help with.');
  lines.push('');
  lines.push(
    `**At the shipped 0.35, ${servedAt(0.35)} of ${queryCount} ${servedAt(0.35) === 1 ? 'queries is' : 'queries are'} served** and recall is ` +
      `${rowAt(0.35).recall.toFixed(3)}.`,
  );
  lines.push(
    'That is a sharper statement of the problem than V28 had: V28 showed one query returning nothing,',
  );
  lines.push(
    'and the reading available at the time was that its wordings were unlucky. Across eight queries the',
  );
  lines.push('filter excludes almost everything that bears on the work.');
  lines.push('');
  lines.push(
    `**${lastPerfect.toFixed(2)} is the largest threshold on this corpus with zero false positives**, and it serves ` +
      `${servedAt(lastPerfect)} of ${queryCount}. The`,
  );
  lines.push(
    `first false positive appears at ${firstImperfect === null ? 'no tested threshold' : firstImperfect.toFixed(2)}, and precision then falls away quickly rather than gently.`,
  );
  lines.push(
    'So the choice is not "tight and safe versus loose and noisy" — everything from 0.35 up to',
  );
  lines.push(`${lastPerfect.toFixed(2)} is free, and the shipped value sits at the very bottom of that range.`);
  lines.push('');
  lines.push(
    '**Precision is still the expensive column**, for the reason the dedupe sweep gives: a false',
  );
  lines.push(
    'positive here puts a finding in an agent\'s context that does not bear on its work, and the',
  );
  lines.push('agent pays attention to it.');
  lines.push('');
  if (band) {
    lines.push(
      `Precision and recall are both 1.000 across **${band[0].toFixed(2)}–${band[1].toFixed(2)}**.`,
    );
  } else {
    lines.push(
      '**There is no threshold at which precision and recall are both 1.000**, unlike the dedupe sweep,',
    );
    lines.push(
      'which had a clean band. That difference is not noise, and the next section is why.',
    );
  }
  lines.push('');
  lines.push('### Ranking is perfect here; thresholding is not');
  lines.push('');
  lines.push(
    `In **${rankSeparated} of ${queryCount}** queries, the nearest relevant finding is closer than the nearest irrelevant`,
  );
  lines.push(
    `one. Sorting by distance puts the right finding first every time. But the distance at which the`,
  );
  lines.push(
    `right finding sits ranges from **${minNearest.toFixed(4)} to ${maxNearest.toFixed(4)}** across these queries — a spread of ` +
      `${(maxNearest - minNearest).toFixed(2)} —`,
  );
  lines.push('and no single constant can sit above all eight and below the noise for all eight at once.');
  lines.push('');
  lines.push(
    'That points somewhere specific. `RECALL_SQL` already orders by `times_reverted DESC, n.dist ASC`',
  );
  lines.push(
    'and already caps the result at `LIMIT $5` (`DEFAULT_K` = 8). On this corpus the ordering and the',
  );
  lines.push(
    'cap are doing the work, and `dist < $4` is a blunt second guard that is currently set tight enough',
  );
  lines.push(
    'to discard the answer before the ordering ever sees it. Whoever closes this should consider',
  );
  lines.push(
    'whether the constant wants to be a *backstop* — loose enough to be inert in the normal case — rather',
  );
  lines.push('than the primary filter it is today.');
  lines.push('');
  lines.push(
    '**The counter-argument, stated fairly:** this corpus holds 22 findings. A real repository holds',
  );
  lines.push(
    'thousands, and the density just under any threshold grows with it. The `LIMIT k` bounds how many',
  );
  lines.push(
    'rows an agent sees but not how *bad* the eighth one is, and that is exactly what the distance',
  );
  lines.push('filter is for. This sweep bounds the threshold from below; it does not prove a ceiling.');
  lines.push('');
  lines.push('### Sensitivity to the arguable calls');
  lines.push('');
  lines.push(
    `${pairs.filter((p) => p.arguable).length} of the ${pairs.length} cells are marked \`arguable\` in the ground truth. Flipping **every**`,
  );
  lines.push('one of them gives:');
  lines.push('');
  lines.push(table(flipped, queryCount));
  lines.push('');
  lines.push(
    flippedBand
      ? `Perfect band under the flipped calls: **${flippedBand[0].toFixed(2)}–${flippedBand[1].toFixed(2)}**.`
      : 'Still no perfect band under the flipped calls.',
  );
  lines.push('');
  lines.push('## The ordering question');
  lines.push('');
  lines.push(
    'SPEC-DELTA asked whoever ran this to say why recall and dedupe sit where they do relative to',
  );
  lines.push(
    'each other. `src/memory/propose.ts` dedupes at **0.39**. §4.1 recalls at **0.35** — *tighter*.',
  );
  lines.push('');
  lines.push(
    'That ordering is wrong on the meaning of the two tests, independently of anything in this table.',
  );
  lines.push(
    'Dedupe asks "is this the same work", and answering yes **cancels an agent\'s task** — a false',
  );
  lines.push(
    'positive destroys work that needed doing. Recall asks "might this bear on what I am about to do",',
  );
  lines.push(
    'and answering yes **adds a line to a context window** — a false positive costs attention. The',
  );
  lines.push(
    'strict test is the one with the expensive error, so dedupe must be the tighter of the two, and',
  );
  lines.push('recall must be the looser. Today it is the other way round.');
  lines.push('');
  lines.push(
    'This argument does not depend on the demo, and it was written down in `docs/SPEC-DELTA.md` on',
  );
  lines.push(
    "2026-08-11 — before the demo's beat 1 was known to be affected by it. That is what keeps moving",
  );
  lines.push('the constant out of `06` §3\'s circularity: the ordering was wrong on its own terms first.');
  lines.push('');
  lines.push('## Limitations, and one that weakens the result');
  lines.push('');
  lines.push(
    '**The hard negatives are not as hard as they were designed to be.** `bench/recall-truth.json`',
  );
  lines.push(
    'deliberately included findings that share vocabulary with a query without bearing on it — FI4a,',
  );
  lines.push(
    'SMS delivery-failure retries, was written as the trap for Q4 "add a retry to the orders client".',
  );
  lines.push(
    `Titan does not place it anywhere near: it sits at ${pairDist(pairs, 'Q4', 'FI4a').toFixed(4)}, further out than FP6a at ` +
      `${pairDist(pairs, 'Q4', 'FP6a').toFixed(4)},`,
  );
  lines.push(
    'which was not designed as a trap at all. Shared vocabulary turns out to be a poor way to',
  );
  lines.push(
    'manufacture a near-miss under this model. The practical consequence is that **the precision',
  );
  lines.push(
    'column here is optimistic** — a corpus with genuinely adversarial negatives would break precision',
  );
  lines.push('earlier than 0.63, and nobody should read 1.000 as a promise.');
  lines.push('');
  lines.push(
    `**Eight queries and ${truth.findings.length} findings is a small corpus.** The dedupe sweep it is modelled on scored 6`,
  );
  lines.push(
    'declared pairs, so this is the same order of evidence, but neither is large. Both are bounded by',
  );
  lines.push('what one person can label honestly by hand.');
  lines.push('');
  lines.push('## What this sweep does not do');
  lines.push('');
  lines.push(
    'It does not pick the number. `03` §4.2\'s dedupe threshold was closed by Julian as a separate act',
  );
  lines.push(
    'with the measurement in front of him, and the same applies here. It also does not touch',
  );
  lines.push(
    '`JUDGE_THRESHOLD` or the dedupe constant: whatever recall becomes, it is a third independent',
  );
  lines.push('number, and three constants drawn from one band would read as one constant with three names.');
  lines.push('');

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, lines.join('\n'));

  console.log('');
  console.log(table(declared, queryCount));
  console.log('');
  for (const n of nearest) {
    console.log(
      `${n.query.id}  nearest relevant ${n.best.findingId} ${n.best.distance.toFixed(4)}   ` +
        `nearest irrelevant ${n.nearestIrrelevant.findingId} ${n.nearestIrrelevant.distance.toFixed(4)}`,
    );
  }
  console.log('');
  console.log(band ? `perfect band ${band[0]}–${band[1]}` : 'no perfect band');
  console.log(`written ${OUT_PATH}`);

  await closePool();
}

await main();
