/**
 * THE ORACLE, AND THE FENCE AROUND IT.
 *
 * `bench/demo-app/acceptance.ts` decides the interlocks by **running the app** rather than by
 * looking for a committed patch's text in a file. That change is the whole reason this file
 * exists, and it carries two obligations that a passing oracle does not discharge on its own:
 *
 * 1. **The oracle must be withheld from the agents.** A corpus whose test suite the agent can
 *    read is a specification it optimises against, and the question quietly turns from *"did the
 *    agent do the work"* into *"did the agent make the tests pass"*. So this file asserts the
 *    fence: not in `APP_FILES`, not in a tree anything hands an agent, not in the assembled
 *    document, and not referred to by any module outside `test/`. The last one is the one that
 *    matters later — the prompt builder does not exist yet, and when it does, importing the
 *    oracle fails here.
 * 2. **The oracle must be able to fail.** A check that cannot fail is not a check, and an oracle
 *    that passes on every tree is worse than none: it would certify the naive lane. So every
 *    ticket check is run against the baseline, where it must fail, and every composition check
 *    is run against a tree engineered to break exactly it.
 *
 * **What "both arms' correct trees" means here.** Each lane's *intended* tree — every ticket
 * that lane applied, in the variant it chose, with no write-back loss. Both pass every ticket
 * check, which is design §3.1's sharpest claim executable: **neither agent wrote a bug.** What
 * separates the lanes is the composition checks and, for interlock 3, the lossy tree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPOSITION_CHECKS,
  TICKET_CHECKS,
  checkById,
  runChecks,
  type AcceptanceCheck,
  type CheckResult,
} from '../bench/demo-app/acceptance.js';
import { DEMO_TASKS, patchesFor } from '../bench/demo-workload.js';
import { APP_FILES, assembleApp } from '../src/demo/app-bundle.js';
import { EXPORTED_GLOBALS } from '../src/demo/evaluate.js';
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function baseline(): FileTree {
  return loadFixtureTree(APP_FILES, DEMO_APP_CORPUS);
}

/** `[ticket, informed]` pairs, applied in order to one tree. */
type Applied = readonly (readonly [string, boolean])[];

function applyAll(tree: FileTree, entries: Applied): FileTree {
  let next = tree;
  for (const [id, informed] of entries) {
    for (const patch of patchesFor(id, informed)) next = applyPatch(next, patch);
  }
  return next;
}

/**
 * What the CORTEX lane ends up with: the informed variant wherever recall carried a decision,
 * and nothing at all for the two tickets arbitration deduped.
 */
const CORTEX_APPLIED: Applied = [
  ['I3', false], ['P2a', false], ['P6a', false],
  ['C1', false], ['C2', false], ['C3', true], ['R3', true],
];

/**
 * What the NAIVE lane's agents each intended.
 *
 * `P6b` is here and `P2b` is not, and that asymmetry is measured rather than chosen: the naive
 * lane runs the same dedupe statement, so it catches the *sequenced* P2 pair, and misses the
 * P6 pair because those two race (V50).
 */
const NAIVE_APPLIED: Applied = [
  ['I3', false], ['P2a', false], ['P6a', false], ['P6b', false],
  ['C1', false], ['C2', false], ['C3', false], ['R3', false],
];

const cortexTree = () => applyAll(baseline(), CORTEX_APPLIED);
const naiveTree = () => applyAll(baseline(), NAIVE_APPLIED);

/**
 * The NAIVE lane's tree as it actually lands: three agents read the shared tree, work on their
 * own snapshot of it and save the files they edited over whatever arrived meanwhile.
 *
 * Built the way `test/patches.test.ts` builds it — the shared tree is read **once** and all
 * three agents work from that same object, because three independent reads cannot share state
 * to corrupt and the test would pass for the wrong reason.
 */
function naiveLossyTree(): FileTree {
  const shared = applyAll(baseline(), NAIVE_APPLIED.filter(([id]) => !id.startsWith('C')));

  const snapshots = (['C1', 'C2', 'C3'] as const).map((id) => ({
    id,
    files: patchesFor(id).map((patch) => patch.file),
    mine: patchesFor(id).reduce<FileTree>((tree, patch) => applyPatch(tree, patch), shared),
  }));

  const saved: FileTree = { ...shared };
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) saved[file] = snapshot.mine[file]!;
  }
  return saved;
}

function verdictOf(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
}

/** Every ticket the cut carries code for — the set the oracle owes a check to. */
const TICKETS_WITH_CODE = DEMO_TASKS.filter((task) => task.patches.length > 0).map((t) => t.id);

describe('the oracle is withheld from the agents', () => {
  it('is not one of the corpus files an agent is handed', () => {
    // `APP_FILES` is what `loadFixtureTree` reads and what any prompt over this corpus would be
    // built from. The oracle being outside it is the fence's first plank.
    expect(APP_FILES).not.toContain('acceptance.ts');
    for (const file of APP_FILES) expect(file).not.toContain('acceptance');
    for (const file of Object.keys(baseline())) expect(file).not.toContain('acceptance');
  });

  it('is not in the document the page renders either', () => {
    // The assembled app is a demo surface, and a judge can view its source.
    const html = assembleApp(baseline());
    expect(html).not.toContain('AcceptanceCheck');
    expect(html).not.toContain('COMPOSITION_CHECKS');
    expect(html).not.toContain('acceptance');
  });

  it('is referred to by nothing outside test/', () => {
    // This is the plank that matters *later*. Nothing builds a model prompt today; when
    // something does, importing the oracle to "check the agent's work" would hand the corpus's
    // own scoring to the thing being scored, and it would do so silently. This fails instead.
    const specifier = /(?:from|import|require)\s*\(?\s*['"][^'"]*acceptance[^'"]*['"]/;
    const offenders: string[] = [];

    for (const root of ['src', 'scripts', 'bench', 'infra/lambda']) {
      for (const file of sourceFilesUnder(join(REPO_ROOT, root))) {
        if (file.endsWith(join('bench', 'demo-app', 'acceptance.ts'))) continue;
        if (specifier.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('and the scan above is not vacuous — it finds this file importing it', () => {
    // A regex that matched nothing would make the assertion above an unconditional pass, which
    // is exactly the shape of guard this repository has been bitten by before.
    const specifier = /(?:from|import|require)\s*\(?\s*['"][^'"]*acceptance[^'"]*['"]/;
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(specifier.test(self)).toBe(true);
  });
});

describe('the evaluator names every global the corpus defines', () => {
  it('nothing declared at the top level of a corpus file is missing from the list', () => {
    // `evaluate` returns an object literal naming each global, so a name that is not on the
    // list is simply unreachable — a check reaching for it reads as `undefined is not a
    // function`, which looks like a broken corpus rather than a short list.
    const tree = baseline();
    const declared: string[] = [];

    for (const file of APP_FILES) {
      if (!file.endsWith('.js') || file.startsWith('web/')) continue;
      for (const line of (tree[file] ?? '').split('\n')) {
        const asFunction = /^function ([A-Za-z_$][\w$]*)\s*\(/.exec(line);
        const asVariable = /^var ([A-Za-z_$][\w$]*)\s*=/.exec(line);
        const name = asFunction?.[1] ?? asVariable?.[1];
        if (name !== undefined) declared.push(name);
      }
    }

    expect(declared.length).toBeGreaterThan(100);
    expect(declared.filter((name) => !EXPORTED_GLOBALS.includes(name as never))).toEqual([]);
  });
});

describe('the oracle covers the work and says what it saw', () => {
  it('has one ticket check per ticket that carries code, and no others', () => {
    expect(TICKET_CHECKS.map((one) => one.id).sort()).toEqual([...TICKETS_WITH_CODE].sort());
  });

  it('has one composition check per interlock that leaves a difference in the code', () => {
    // Four, not five. Interlock 5's two tickets patch nothing, so both lanes' trees are
    // identical and no question asked of a tree can separate them — a fifth check here would
    // pass in every lane for ever, which is the definition of a check that is not one.
    expect(COMPOSITION_CHECKS.map((one) => one.id)).toEqual([
      'interlock-1', 'interlock-2', 'interlock-3', 'interlock-4',
    ]);
  });

  it('every check has a unique id and a title', () => {
    const all: readonly AcceptanceCheck[] = [...TICKET_CHECKS, ...COMPOSITION_CHECKS];
    const ids = all.map((one) => one.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const one of all) expect(one.title.length).toBeGreaterThan(0);
    expect(() => checkById('interlock-1')).not.toThrow();
    expect(() => checkById('nothing-by-this-name')).toThrow(/no acceptance check/);
  });

  it('never answers with a bare verdict — every result carries what it observed', () => {
    // `observed` is what the page renders as evidence. A result that passed with an empty
    // string is a row a reader has to take on trust.
    const results = [
      ...runChecks(TICKET_CHECKS, cortexTree()),
      ...runChecks(COMPOSITION_CHECKS, naiveTree()),
    ];
    for (const result of results) expect(result.observed.length).toBeGreaterThan(0);
  });

  it('reports a tree it cannot run as an error rather than as a failure', () => {
    // A lane that lost a whole file is a different fact from a lane that answers wrongly, and
    // the page must not report the first as the second. This is also the only thing that
    // proves the third verdict is reachable at all.
    const broken = baseline();
    delete broken['orders/repository.js'];

    const result = checkById('C1').run(broken);
    expect(result.verdict).toBe('error');
    expect(result.observed).toMatch(/does not run/);
  });
});

describe("both arms' correct trees pass every ticket check", () => {
  it('each ticket, in each variant, works on a tree carrying only that ticket', () => {
    // "Independent of the other agents", literally: nothing else has been applied. Both
    // variants where a ticket has two, because an informed patch that is correct only in
    // company is a patch the demo cannot claim was correct on its own.
    for (const task of DEMO_TASKS) {
      if (task.patches.length === 0) continue;

      for (const informed of task.informedPatches ? [false, true] : [false]) {
        const tree = applyAll(baseline(), [[task.id, informed]]);
        const result = checkById(task.id).run(tree);
        expect({ ...result, informed }).toMatchObject({ id: task.id, verdict: 'pass' });
      }
    }
  });

  it('the CORTEX lane delivered every ticket it did not dedupe', () => {
    const results = runChecks(
      TICKET_CHECKS.filter((one) => CORTEX_APPLIED.some(([id]) => id === one.id)),
      cortexTree(),
    );
    expect(results.filter((r) => r.verdict !== 'pass')).toEqual([]);
    expect(results.length).toBe(CORTEX_APPLIED.length);
  });

  it('and so did the NAIVE lane, ticket by ticket — nobody in it wrote a bug', () => {
    // The demo's argument depends on this being true. If a naive agent's work failed its own
    // ticket the page would be showing incompetence rather than a coordination failure, and
    // `06` §5's methodological point would be gone.
    //
    // `P2b` is checked here even though the lane deduped it: the feature is present, delivered
    // by whichever half won, which is what its check asks.
    const results = runChecks(TICKET_CHECKS, naiveTree());
    expect(results.filter((r) => r.verdict !== 'pass')).toEqual([]);
  });
});

describe('the composition checks separate the lanes', () => {
  it('the CORTEX tree passes all four', () => {
    expect(runChecks(COMPOSITION_CHECKS, cortexTree()).filter((r) => r.verdict !== 'pass')).toEqual([]);
  });

  it('the NAIVE tree fails interlocks 1, 2 and 4 while every ticket in it passed', () => {
    // The gap this whole demo is about, in one assertion: every agent's work is individually
    // correct (asserted above, same tree) and the app is wrong in three places.
    const results = runChecks(COMPOSITION_CHECKS, naiveTree());

    expect(verdictOf(results, 'interlock-1').verdict).toBe('fail');
    expect(verdictOf(results, 'interlock-2').verdict).toBe('fail');
    expect(verdictOf(results, 'interlock-4').verdict).toBe('fail');
  });

  it('and it passes interlock 3, because that one is a lost write rather than a composition', () => {
    // Worth its own assertion. If interlock 3 failed here too, the oracle would be reporting
    // "the naive lane fails everything", and the distinction between two correct changes
    // composing wrongly and a change that is simply gone — which is the difference between
    // `src/demo/attribution.ts` having something to say and having nothing — would be lost.
    expect(verdictOf(runChecks(COMPOSITION_CHECKS, naiveTree()), 'interlock-3').verdict).toBe('pass');
  });

  it('interlock 3 fails only once last-write-wins has been through the shared file', () => {
    const results = runChecks(COMPOSITION_CHECKS, naiveLossyTree());
    const lost = verdictOf(results, 'interlock-3');

    expect(lost.verdict).toBe('fail');
    // Named, not merely counted. The panel accuses somebody of losing a specific feature.
    expect(lost.observed).toMatch(/pager/);
    expect(lost.observed).toMatch(/timeline/);
  });
});

describe('the oracle can fail — mutation, not assertion', () => {
  it('every ticket check fails on the baseline', () => {
    // The strongest mutation available and the cheapest: remove the work. A ticket check that
    // still passes with nothing applied is measuring something that was already there, which is
    // exactly the way a green suite certifies an empty lane.
    for (const result of runChecks(TICKET_CHECKS, baseline())) {
      expect(result).toMatchObject({ verdict: 'fail' });
    }
  });

  it('every composition check fails on a tree engineered to break exactly it', () => {
    const MUTATIONS: { id: string; tree: FileTree; reads: RegExp }[] = [
      // Money moved to minor units and shipping priced in pounds. Both correct alone.
      { id: 'interlock-1', tree: applyAll(baseline(), [['I3', false], ['R3', false]]), reads: /renders/ },
      // A correct cache and a correct guard, and the guard reads the cache.
      { id: 'interlock-2', tree: applyAll(baseline(), [['P2a', false], ['C3', false]]), reads: /shelf left at -1/ },
      // Three disjoint hunks in one file, written back whole.
      { id: 'interlock-3', tree: naiveLossyTree(), reads: /missing/ },
      // The same feature delivered twice, in two files, with no conflict anywhere.
      { id: 'interlock-4', tree: applyAll(baseline(), [['P6a', false], ['P6b', false]]), reads: /2 banner/ },
    ];

    for (const mutation of MUTATIONS) {
      const result = checkById(mutation.id).run(mutation.tree);
      expect(result).toMatchObject({ id: mutation.id, verdict: 'fail' });
      expect(result.observed).toMatch(mutation.reads);
    }
  });

  it('and passes on the tree where that same defect was avoided', () => {
    // The other half of a mutation test. A check that failed on every tree would be as useless
    // as one that passed on every tree, and only asserting both directions tells them apart.
    const PAIRS: { id: string; tree: FileTree }[] = [
      { id: 'interlock-1', tree: applyAll(baseline(), [['I3', false], ['R3', true]]) },
      { id: 'interlock-2', tree: applyAll(baseline(), [['P2a', false], ['C3', true]]) },
      { id: 'interlock-3', tree: naiveTree() },
      { id: 'interlock-4', tree: applyAll(baseline(), [['P6a', false]]) },
    ];

    for (const pair of PAIRS) {
      expect(checkById(pair.id).run(pair.tree)).toMatchObject({ id: pair.id, verdict: 'pass' });
    }
  });
});

/** Every source file under a directory, recursively. Skips `node_modules` and build output. */
function sourceFilesUnder(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'cdk.out' || entry.startsWith('.')) continue;
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFilesUnder(path));
    } else if (/\.(ts|mts|mjs|js)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}
