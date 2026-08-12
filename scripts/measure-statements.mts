/**
 * The distances between every pair of demo statements, under live Titan, computed by the
 * cluster.
 *
 *   npm run measure:statements
 *
 * `docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §3: "Task statements are
 * load-bearing and must be measured... Any statement added or reworded for this cut is
 * measured against the others under live Titan before it ships, and the measured distance
 * goes in the comment. **This is not optional and no test can substitute for it.**"
 *
 * The reason is recorded in `src/demo/scenario.ts` and it cost a beat: a seed statement
 * chosen by ear sat **0.2969** from agent-2's intent — inside the dedupe threshold — so the
 * demo deduped against its own seed and beat 4 never fired. No unit test could have caught
 * it, because unit tests control distances by construction. This is a fact about what Titan
 * does to particular English sentences, and the only way to know it is to ask.
 *
 * Distances come from CockroachDB's own `<=>` via `DISTANCE_SQL`, not from arithmetic here,
 * for the same reason `src/memory/duplicates.ts` does it that way: the mechanism arbitrates
 * on the cluster's operator, and a number computed in TypeScript agrees with it only for as
 * long as two implementations happen to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { withRetry } from '../src/db/retry.js';
import { Embedder } from '../src/embed/titan.js';
import { DISTANCE_SQL } from '../src/memory/duplicates.js';
import { CONSOLIDATION_DISTANCE } from '../src/memory/consolidate.js';
import { DEFAULT_MAX_DISTANCE as RECALL_MAX } from '../src/memory/recall.js';
import { DEFAULT_DEDUPE_THRESHOLD, toVector } from '../src/memory/propose.js';
import { SCRIPT } from '../src/demo/scenario.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

interface Task {
  id: string;
  kind: string;
  statement: string;
  resourceKeys: string[];
  pair?: string;
  dependsOn?: string;
}

/**
 * Everything a curated cut could draw on, plus the seed that must stay far from all of it.
 *
 * Deliberately wider than the ten tasks §3 asks for: the point is to *choose* the cut on
 * measured margins rather than to confirm a cut chosen by ear.
 */
const CANDIDATES = [
  ...'P1a P1b P2a P2b P3a P3b P4a P4b P5a P5b P6a P6b'.split(' '),
  ...'C1 C2 C3 C4 C5'.split(' '),
  ...'I3 R3 P3a R2'.split(' '),
  'A1',
];

/**
 * The ten-task cut, chosen from the run above on measured margins (2026-08-12).
 *
 * Two duplicate pairs, one contended trio, the recall pair and its dependency, one
 * abandoned task — design §3's slices exactly.
 *
 * **Why these two pairs and not the other four.** P6 (0.0610) and P2 (0.2058) have the widest
 * margins inside the 0.39 threshold, and they demonstrate two different shapes: P6's halves
 * touch *different* files, so dedupe fires with no claim overlap at all, while P2's touch the
 * same one. P3 was rejected at 0.3630 — a margin of 0.0270 is too thin to hang a demo on,
 * since it sits exactly on the lower edge of the sweep's perfect band and any re-record could
 * push it over. P1 at 0.3203 is second-best and is the reserve.
 */
const CUT = ['P6a', 'P6b', 'P2a', 'P2b', 'C1', 'C2', 'C3', 'I3', 'R3', 'A1'];

/**
 * The fourteen-day-old seed, which design §3 says carries forward — but which now has a job
 * it did not have before.
 *
 * In the current scenario the seed's fact is what beat 1 recalls. In this cut the recall
 * slice is I3 → R3, so an unchanged seed would sit at 0.6325 from its nearest neighbour and
 * be recalled by nothing at all: present, inert, and decorative. The candidates below tie the
 * seed to the story the cut already tells — money moved to integer minor units, and it went
 * wrong once.
 *
 * **The seed's fact and the seed's statement do not share a constraint, and the first run of
 * this script got that wrong.** They live in different tables and are searched by different
 * queries at different thresholds:
 *
 *   - the **fact** is consolidated into `findings`. `findDuplicate` never looks there, so a
 *     fact cannot dedupe a task however close it sits. What it must satisfy is
 *     **under 0.60 from R3's statement** (`03` §4.1's recall threshold) or beat 1 stays dark,
 *     and **over 0.20** from whatever R3's own closure consolidates, or `consolidate()`
 *     reinforces the seed instead of inserting and semantic memory books two corroborations
 *     for one event — the `conf 0.60 · ×2` bug `src/demo/scenario.ts` already records.
 *   - the **statement** becomes an intent, closed as reverted, which `03` §4.3 maps to status
 *     `done` — so it *is* in `findDuplicate`'s candidate set and must stay **over 0.39 from
 *     every task statement in the cut**. That is the constraint that deleted beat 4 once
 *     before, at 0.2969.
 *
 * The consequence is a design one: the seed's **statement must stay in a different domain
 * from the cut**, while its **fact belongs squarely in the cut's domain**. A seed intent
 * written about minor units to make the story tidy would sit inside 0.39 of I3 and dedupe the
 * very task it exists to inform.
 */
const SEED_CANDIDATES: Record<string, string> = {
  'S1-fact':
    'converting stored amounts to integer minor units silently doubled every shipping quote and was reverted',
  'S2-fact':
    'the integer minor unit conversion was reverted: stored quotes were already in minor units and got scaled twice',
  'S3-fact':
    'money stored as integer minor units broke shipping quotes, which were already minor units — reverted',
};

/**
 * The eleventh task — demo-owned, and it cannot live in `bench/tasks.json`.
 *
 * That file is the *benchmark's* corpus. `08` §4's end-of-day-two gate is passed against
 * exactly 30 tasks with the results committed under `bench/results/`, and the fleet-demo
 * design §1 freezes "the published benchmark and its committed results". An eleventh task
 * added there would change the published workload and invalidate the table. So the demo's
 * curated cut becomes its own file that *references* benchmark task ids and adds this one.
 *
 * **What it is for.** A1 is abandoned as impossible — the payment provider's v3 API is not
 * available on this account. Until 2026-08-12 that knowledge reached nobody: consolidation
 * ignored abandoned rows, the changefeed sink ignored them, and `findDuplicate` excludes
 * them. Now abandonment consolidates, so this task is the agent that gets spared.
 *
 * **Its two constraints, and note that they are not the seed's two.**
 *   - **under 0.60 from A1's FINDING** — the abandonReason text, which is what
 *     `factFromClosedIntent` writes into `findings` — or recall never returns it.
 *   - **over 0.39 from every other task in the cut.** Not from A1 itself: A1 is
 *     `abandoned`, and `findDuplicate`'s candidate set is `status IN ('in_flight','done')`,
 *     so A1 can never dedupe anything. That exclusion is deliberate and stays — a later
 *     agent is *informed* that something was given up, never *stopped* from trying.
 */
/**
 * Three ways A1's abandonment could be written into `findings`, because the first attempt
 * measured at 0.67–0.72 from every candidate task and would have been recalled by nobody.
 *
 * `factFromClosedIntent` prefers `outcome.notes` and falls back to `"<statement> — <result>"`.
 * So which of these ships is a **demo authoring choice** — what the abandoning agent writes —
 * not a mechanism change.
 *
 * The hypothesis being tested: a terse abandonReason names only the *obstacle*, while the
 * task that needs it names the *work*. Titan has no reason to put those near each other. A
 * finding that names both should sit much closer to the task it is meant to warn.
 */
const FACT_CANDIDATES: Record<string, string> = {
  // What A1's abandonReason says today. Names the obstacle only.
  'F-reason':
    "The provider's v3 API is not available on this account, so the work cannot be completed.",
  // What `factFromClosedIntent` produces with no notes at all. Names the work only.
  'F-fallback':
    'Migrate the payment provider integration to their version three API — abandoned',
  // Names both.
  'F-both':
    "Migrating the payment provider integration to their version three API was abandoned: the provider's v3 API is not available on this account.",
};

const NEW_TASK_CANDIDATES: Record<string, string> = {
  'T1': "Move the refund flow onto the payment provider's v3 API",
  'T2': 'Port the refund path to version three of the payment provider API',
  'T3': "Switch refunds over to the payment provider's v3 endpoints",
};

function tasks(): Map<string, Task> {
  const file = JSON.parse(readFileSync(resolve('bench/tasks.json'), 'utf8')) as { tasks: Task[] };
  return new Map(file.tasks.map((t) => [t.id, t]));
}

async function main(): Promise<void> {
  const all = tasks();
  const wanted = [...new Set(CANDIDATES)];

  const items: { id: string; statement: string }[] = wanted.map((id) => {
    const task = all.get(id);
    if (!task) throw new Error(`no such task in bench/tasks.json: ${id}`);
    return { id, statement: task.statement };
  });

  // The seed carries forward from the current scenario (design §3) and is the statement
  // that has already gone wrong once.
  items.push({ id: 'SEED-fact', statement: SCRIPT.seedFact });
  items.push({ id: 'SEED-stmt', statement: SCRIPT.seedStatement });

  console.log(`embedding ${items.length} statements with live Titan...`);
  const embedder = new Embedder();
  const vectors = new Map<string, string>();
  for (const item of items) {
    vectors.set(item.id, toVector(await embedder.embed(item.statement)));
  }
  console.log(`Bedrock calls: ${embedder.stats.invocations}, cache hits: ${embedder.stats.hits}\n`);

  const distance = async (a: string, b: string): Promise<number> =>
    withRetry(async (client) => {
      const { rows } = await client.query<{ dist: number }>(DISTANCE_SQL, [
        vectors.get(a),
        vectors.get(b),
      ]);
      return Number(rows[0]?.dist ?? NaN);
    });

  const pairs: { a: string; b: string; dist: number }[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i]!.id;
      const b = items[j]!.id;
      pairs.push({ a, b, dist: await distance(a, b) });
    }
  }

  const declared = (a: string, b: string): boolean => {
    const ta = all.get(a);
    const tb = all.get(b);
    return ta?.pair !== undefined && ta.pair === tb?.pair;
  };

  console.log(`dedupe threshold: ${DEFAULT_DEDUPE_THRESHOLD}\n`);

  console.log('DECLARED DUPLICATE PAIRS — these must land INSIDE the threshold');
  const intra = pairs.filter((p) => declared(p.a, p.b)).sort((x, y) => x.dist - y.dist);
  for (const p of intra) {
    const ok = p.dist < DEFAULT_DEDUPE_THRESHOLD;
    console.log(
      `  ${ok ? 'fires ' : 'MISSES'}  ${p.a}/${p.b}  ${p.dist.toFixed(4)}` +
        `   margin ${(DEFAULT_DEDUPE_THRESHOLD - p.dist).toFixed(4)}`,
    );
  }

  console.log('\nEVERYTHING ELSE — these must stay OUTSIDE it');
  const cross = pairs.filter((p) => !declared(p.a, p.b)).sort((x, y) => x.dist - y.dist);
  const violations = cross.filter((p) => p.dist < DEFAULT_DEDUPE_THRESHOLD);
  for (const p of cross.slice(0, 12)) {
    const bad = p.dist < DEFAULT_DEDUPE_THRESHOLD;
    console.log(
      `  ${bad ? 'COLLIDES' : 'clear   '}  ${p.a}/${p.b}  ${p.dist.toFixed(4)}` +
        `   margin ${(p.dist - DEFAULT_DEDUPE_THRESHOLD).toFixed(4)}`,
    );
  }
  console.log(`  ... ${cross.length - 12} further pairs, all wider`);

  console.log('\nSEED — must be far from every task it shares a run with');
  for (const id of ['SEED-fact', 'SEED-stmt']) {
    const nearest = cross
      .filter((p) => p.a === id || p.b === id)
      .sort((x, y) => x.dist - y.dist)[0];
    if (nearest) {
      console.log(
        `  ${id}  nearest ${nearest.a === id ? nearest.b : nearest.a} at ${nearest.dist.toFixed(4)}`,
      );
    }
  }

  console.log(
    `\n${intra.filter((p) => p.dist < DEFAULT_DEDUPE_THRESHOLD).length}/${intra.length} declared pairs fire; ` +
      `${violations.length} undeclared collisions.`,
  );

  // ---- The chosen cut, and the seed that has to live alongside it --------------------
  console.log(`\n\nTHE CUT — ${CUT.join(' ')}`);
  const inCut = (p: { a: string; b: string }) => CUT.includes(p.a) && CUT.includes(p.b);
  const cutCross = cross.filter(inCut).sort((x, y) => x.dist - y.dist);
  const cutIntra = intra.filter(inCut);
  for (const p of cutIntra) {
    console.log(`  dedupes  ${p.a}/${p.b}  ${p.dist.toFixed(4)}`);
  }
  console.log(
    `  closest non-pair inside the cut: ${cutCross[0]?.a}/${cutCross[0]?.b} ` +
      `${cutCross[0]?.dist.toFixed(4)}`,
  );

  console.log('\nSEED FACT CANDIDATES — go to `findings`, so dedupe never sees them');
  console.log(`  recalled by R3 if < ${RECALL_MAX}; merged into by consolidation if < ${CONSOLIDATION_DISTANCE}`);
  for (const [id, text] of Object.entries(SEED_CANDIDATES)) {
    vectors.set(id, toVector(await embedder.embed(text)));

    const toR3 = await distance(id, 'R3');
    const recalled = toR3 < RECALL_MAX;
    const distinct = toR3 > CONSOLIDATION_DISTANCE;
    console.log(
      `  ${recalled && distinct ? 'USABLE' : 'no    '}  ${id}  R3 ${toR3.toFixed(4)}  ` +
        `${recalled ? 'recalled' : 'TOO FAR — beat 1 stays dark'}` +
        `${distinct ? '' : ', BUT would be merged rather than corroborated'}` +
        `${recalled && distinct ? `  (rank margin ${(RECALL_MAX - toR3).toFixed(4)})` : ''}`,
    );
  }

  console.log('\nSEED STATEMENT — becomes an intent, so it IS a dedupe candidate');
  let worstId = '';
  let worst = Infinity;
  for (const other of CUT) {
    const d = await distance('SEED-stmt', other);
    if (d < worst) {
      worst = d;
      worstId = other;
    }
  }
  console.log(
    `  ${worst > DEFAULT_DEDUPE_THRESHOLD ? 'SAFE' : 'DEDUPES — DELETES A BEAT'}  ` +
      `nearest task in the cut: ${worstId} at ${worst.toFixed(4)}` +
      `  margin ${(worst - DEFAULT_DEDUPE_THRESHOLD).toFixed(4)}`,
  );

  console.log('\n\nTHE ELEVENTH TASK — the agent A1 spares');
  console.log(`  a task recalls a fact if they sit < ${RECALL_MAX} apart\n`);

  for (const [factId, factText] of Object.entries(FACT_CANDIDATES)) {
    vectors.set(factId, toVector(await embedder.embed(factText)));
  }
  for (const [id, text] of Object.entries(NEW_TASK_CANDIDATES)) {
    vectors.set(id, toVector(await embedder.embed(text)));
  }

  console.log('  how A1 writes its finding vs. which tasks can then find it:');
  for (const factId of Object.keys(FACT_CANDIDATES)) {
    const row: string[] = [];
    for (const taskId of Object.keys(NEW_TASK_CANDIDATES)) {
      const d = await distance(factId, taskId);
      row.push(`${taskId} ${d.toFixed(4)}${d < RECALL_MAX ? '*' : ' '}`);
    }
    console.log(`  ${factId.padEnd(11)} ${row.join('   ')}`);
  }
  console.log('  (* = recalled)\n');

  for (const id of Object.keys(NEW_TASK_CANDIDATES)) {
    const toA1 = await distance(id, 'A1');
    let nearestId = '';
    let nearest = Infinity;
    // A1 is excluded: it is `abandoned`, so findDuplicate can never match it.
    for (const other of CUT.filter((c) => c !== 'A1')) {
      const d = await distance(id, other);
      if (d < nearest) {
        nearest = d;
        nearestId = other;
      }
    }
    const safe = nearest > DEFAULT_DEDUPE_THRESHOLD;
    console.log(
      `  ${safe ? 'SAFE' : 'DEDUPES'}  ${id}  nearest live task ${nearestId} ${nearest.toFixed(4)}` +
        `   (A1's own statement ${toA1.toFixed(4)} — excluded from dedupe as abandoned)`,
    );
  }

  await closePool();
}

await main();
