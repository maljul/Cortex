/**
 * A BROKEN APP IS AN ACCUSATION UNTIL IT IS ATTRIBUTED.
 *
 * `docs/UNITS.md`'s U21 names this as its third silent break, and it is the sharp one: a
 * naive app with features missing reads as *"they wrote a broken app"* unless every missing
 * feature carries, on screen, the agent that reported it done, its intent id, and the file
 * where the work is not. Without that link the naive lane is an assertion rather than
 * evidence, and `02` A7 is not satisfied by a page that is merely correct.
 *
 * ## WHAT CHANGED ON 2026-08-16, AND WHY THIS FILE IS THE PROOF
 *
 * Presence used to be decided by looking for the committed patch's replacement text in the
 * tree. `src/demo/author.ts` lets a model write the code instead, and a model implements the
 * same ticket in its own words — so that rule would have reported every feature absent, every
 * naive agent as having lost its work, and would have done it **silently**, with the whole
 * suite green.
 *
 * `attributeFeatures` now takes a probe and asks it. This file supplies the real one:
 * `bench/demo-app/acceptance.ts`, which assembles the tree, runs it, and calls the functions a
 * judge would reach by clicking. A test may import that oracle; `src/`, `scripts/`, `bench/`
 * and `infra/lambda/` may not, and `test/acceptance.test.ts` fails if they ever do — which is
 * exactly why `Feature.works` is injected rather than imported.
 *
 * The regression that motivated the change has its own test below: a tree carrying the same
 * work in different bytes. The old rule reports that feature lost; the new one reports it
 * delivered, and the assertion names both halves so the two cannot be confused later.
 *
 * **The fixtures are the real ones.** Three agents edit `orders/repository.js` at once. Under
 * arbitration all three land; under per-file last-write-wins the file carries only the last
 * agent's change, and `test/patches.test.ts` and `test/acceptance.test.ts` both pin that shape
 * from their own angles. This file proves the difference can be *named*.
 */
import { describe, expect, it } from 'vitest';

import { checkById } from '../bench/demo-app/acceptance.js';
import { patchesFor } from '../bench/demo-workload.js';
import {
  attributeFeatures,
  unattributableLosses,
  type Feature,
  type FeatureAttribution,
  type WorkStep,
} from '../src/demo/attribution.js';
import { APP_FILES } from '../src/demo/app-bundle.js';
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

/** The three tickets that want one file at once — interlock 3, the only one of five this covers. */
const CONTENDERS = ['C1', 'C2', 'C3'] as const;

/**
 * One feature per ticket, and the question that decides it is the oracle's own.
 *
 * `check.run` is passed unbound on purpose and is safe to: the oracle builds each check as a
 * closure over its id and body and never reaches for `this`. Passing the whole check would work
 * too, and would tie this module's `Feature` shape to the oracle's — which is the coupling the
 * injection exists to avoid.
 */
const FEATURES: Feature[] = CONTENDERS.map((id) => {
  const check = checkById(id);
  return {
    id,
    title: check.title,
    files: [...new Set(patchesFor(id).map((patch) => patch.file))],
    works: check.run,
  };
});

function baseline(): FileTree {
  return loadFixtureTree(APP_FILES, DEMO_APP_CORPUS);
}

/** Arbitration: each agent reads the current tree, so all three changes land. */
function cortexTree(): FileTree {
  let tree = baseline();
  for (const id of CONTENDERS) {
    for (const patch of patchesFor(id)) tree = applyPatch(tree, patch);
  }
  return tree;
}

/**
 * Last-write-wins, per file: every agent reads the *same* snapshot and saves back the files it
 * edited, so the file all three share carries only the last agent's change while the files only
 * one of them touched all survive. `06` §2 defines the arm's shared state this way.
 *
 * The shared tree is read **once** and all three agents work from that same object, because
 * three independent reads cannot share state to corrupt and the test would pass for the wrong
 * reason.
 */
function naiveTree(): FileTree {
  const shared = baseline();
  const saved: FileTree = { ...shared };
  for (const id of CONTENDERS) {
    let mine: FileTree = shared;
    for (const patch of patchesFor(id)) mine = applyPatch(mine, patch);
    for (const patch of patchesFor(id)) saved[patch.file] = mine[patch.file]!;
  }
  return saved;
}

/**
 * The CORTEX tree with C1's hunks **written differently and behaving identically** — a comment
 * inside each, which is the smallest possible stand-in for a model that implemented the ticket
 * in its own words.
 *
 * The comment goes *inside* the hunk rather than around it, and that is the whole trick: text
 * appended to a hunk still contains the hunk, so a probe looking for the committed string would
 * go on finding it and this test would prove nothing. Spliced by index rather than with
 * `String.replace`, whose `$` sequences would rewrite a hunk that happened to contain one.
 *
 * Byte-for-byte the committed replacement is gone. Behaviourally nothing moved — which the
 * assertions below check both halves of.
 */
function reworded(): FileTree {
  const tree = cortexTree();
  const next: FileTree = { ...tree };

  for (const patch of patchesFor('C1')) {
    const body = next[patch.file]!;
    const at = body.indexOf(patch.replace);
    expect(at, `${patch.file} does not carry C1's hunk to reword`).toBeGreaterThanOrEqual(0);

    const rewritten =
      `${patch.replace.slice(0, -1)} /* the same work, in other words */${patch.replace.slice(-1)}`;
    next[patch.file] = body.slice(0, at) + rewritten + body.slice(at + patch.replace.length);
  }

  return next;
}

/**
 * What the naive lane's agents reported. All three say `done`, which is the entire point:
 * nothing in that lane can tell an agent its work was overwritten.
 */
const STEPS: WorkStep[] = CONTENDERS.map((id, index) => ({
  taskId: id,
  agent: `agent-${index + 1}`,
  intentId: `00000000-0000-4000-8000-00000000000${index + 1}`,
  reported: 'done',
}));

function records(
  steps: readonly WorkStep[] = STEPS,
  trees: { cortex: FileTree; naive: FileTree } = { cortex: cortexTree(), naive: naiveTree() },
): FeatureAttribution[] {
  return attributeFeatures({ features: FEATURES, ...trees, steps });
}

describe('presence is decided by running the app, not by finding a string', () => {
  /**
   * THE REGRESSION THIS CHANGE EXISTS FOR.
   *
   * Both halves are asserted in one test so that neither can be quietly dropped: the committed
   * text really is gone from the tree (so the old rule would have called the feature lost), and
   * the feature is still reported delivered (because it still works).
   */
  it('finds a feature whose bytes changed and whose behaviour did not', () => {
    const tree = reworded();

    for (const patch of patchesFor('C1')) {
      // The old rule was `tree[patch.file].includes(patch.replace)`. It is false here.
      expect(tree[patch.file]).not.toContain(patch.replace);
    }

    const all = records(STEPS, { cortex: tree, naive: naiveTree() });
    const c1 = all.find((record) => record.feature === 'C1')!;

    expect(c1.inCortex).toBe(true);
    expect(c1.cortex.verdict).toBe('pass');
  });

  it('carries what it observed in each lane, never a bare verdict', () => {
    // `observed` is what the page renders as evidence — "3 pages of sizes [4, 4, 2] over 10
    // orders" is a fact a reader can check. A verdict on its own asks for trust, and `02` A7
    // does not allow the page to ask for it.
    for (const record of records()) {
      expect(record.cortex.observed.length).toBeGreaterThan(0);
      expect(record.naive.observed.length).toBeGreaterThan(0);
    }
  });

  it('reports a probe that throws as an error rather than throwing', () => {
    // A page behind the run button may never show an error (`04` §5 invariant 1), and a
    // home-made probe is the caller's code. This module survives it.
    const exploding: Feature = {
      id: 'C1',
      title: 'a probe that cannot answer',
      files: ['orders/repository.js'],
      works: () => {
        throw new Error('the tree does not run');
      },
    };

    const all = attributeFeatures({
      features: [exploding],
      cortex: cortexTree(),
      naive: naiveTree(),
      steps: STEPS,
    });

    expect(all[0]!.cortex.verdict).toBe('error');
    expect(all[0]!.cortex.observed).toContain('does not run');
    expect(all[0]!.inCortex).toBe(false);
  });
});

describe('every feature is accounted for in both apps', () => {
  it('returns one record per feature, naming the files it belongs to', () => {
    const all = records();

    expect(all).toHaveLength(FEATURES.length);
    for (const record of all) {
      expect(record.files.length).toBeGreaterThan(0);
      expect(record.title.length).toBeGreaterThan(0);
      expect(FEATURES.some((feature) => feature.id === record.feature)).toBe(true);
    }
  });

  /**
   * The non-vacuity guard, and it has to come first. The assertion this file exists for is
   * "every loss is attributable"; over an empty set of losses that is true and worthless.
   * So the shape of the two trees is pinned here.
   *
   * All three tickets work under arbitration. Under per-file last-write-wins the shared file
   * carries only the last agent's change, so exactly one of the three still works — and the
   * other two are losses with a name attached. That is `test/acceptance.test.ts`'s interlock-3
   * result restated as features: not "the app is broken" but "these two agents' work is gone".
   */
  it('finds three features in the CORTEX app and one in the naive app', () => {
    const all = records();

    expect(all.filter((record) => record.inCortex)).toHaveLength(3);
    expect(all.filter((record) => record.inNaive)).toHaveLength(1);
    expect(all.filter((record) => record.inCortex && !record.inNaive)).toHaveLength(2);
  });
});

describe('a missing feature is evidence only if it is attributable', () => {
  /**
   * THE ASSERTION THE UNIT TURNS ON.
   *
   * Every feature present under arbitration and absent without it must carry complete
   * attribution: a named agent, a real intent id, and the files. No nulls, and no intent id
   * that the run's own steps do not contain.
   */
  it('attributes every feature the naive lane lost to an agent and an intent', () => {
    const all = records();
    const lost = all.filter((record) => record.inCortex && !record.inNaive);

    expect(lost.length).toBeGreaterThan(0);

    for (const record of lost) {
      expect(record.agent, `${record.feature} has no agent`).not.toBeNull();
      expect(record.intentId, `${record.feature} has no intent id`).not.toBeNull();
      expect(
        STEPS.some((step) => step.intentId === record.intentId),
        `${record.feature} names an intent id this run never minted`,
      ).toBe(true);
      expect(record.files.length).toBeGreaterThan(0);
      // The evidence a reader checks: the probe says what it saw in the lane that lost it.
      expect(record.naive.observed.length).toBeGreaterThan(0);
    }

    expect(unattributableLosses(all, STEPS)).toEqual([]);
  });

  /**
   * The page must not be able to show "this feature is missing" over a blank agent column.
   * A loss whose task no agent ever reported done is exactly that, and it is caught rather
   * than rendered.
   */
  it('refuses a loss that no agent reported done', () => {
    const lost = records().filter((record) => record.inCortex && !record.inNaive);
    const silent = STEPS.filter((step) => step.taskId !== lost[0]!.feature);
    const all = records(silent);
    const flagged = unattributableLosses(all, silent);

    expect(flagged.map((record) => record.feature)).toContain(lost[0]!.feature);
    for (const record of flagged) expect(record.inCortex && !record.inNaive).toBe(true);
  });

  /**
   * The sharper half of the same rule, and the one a missing-step test cannot reach.
   *
   * An agent that was deduped, blocked or gave up is *present in the run* and did not claim
   * this feature. Attributing the loss to it would put a name and a real intent id beside a
   * feature that agent never said it delivered — a false accusation that passes every null
   * check, because nothing about it is null.
   *
   * Written after a mutation caught the first version of this file: removing
   * `step.reported === 'done'` from `attributeFeatures` left every test green, because every
   * step in the fixture reported `done` and the test above deletes the step rather than
   * changing its verdict. The filter was correct and untested; this is the test.
   */
  it('refuses a loss whose agent reported something other than done', () => {
    const lost = records().filter((record) => record.inCortex && !record.inNaive);
    const subject = lost[0]!.feature;
    const deduped: WorkStep[] = STEPS.map((step) =>
      step.taskId === subject ? { ...step, reported: 'deduped' } : step,
    );
    const all = records(deduped);

    const record = all.find((one) => one.feature === subject)!;
    expect(record.inCortex && !record.inNaive).toBe(true);
    expect(record.agent).toBeNull();
    expect(record.intentId).toBeNull();
    expect(unattributableLosses(all, deduped).map((one) => one.feature)).toContain(subject);
  });

  /**
   * An intent id is attribution only if the run minted it. A record carrying a well-formed
   * id that appears in no step is a page inventing its own evidence, and it is the one
   * failure a null check cannot see.
   */
  it('refuses an intent id that appears in no step of the run', () => {
    const all = records();
    const lost = all.find((record) => record.inCortex && !record.inNaive)!;
    const invented: FeatureAttribution = {
      ...lost,
      intentId: '99999999-9999-4999-8999-999999999999',
    };

    expect(unattributableLosses([invented], STEPS)).toEqual([invented]);
  });

  /**
   * Scoped to losses on purpose. A feature that survived in both lanes accuses nobody, so
   * it needs no agent — and a guard that demanded one would fail every run for the wrong
   * reason.
   */
  it('says nothing about a feature that is present in both apps', () => {
    const kept = records().filter((record) => record.inCortex && record.inNaive);

    expect(kept.length).toBeGreaterThan(0);
    expect(unattributableLosses(kept, [])).toEqual([]);
  });
});
