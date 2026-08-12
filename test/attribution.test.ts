/**
 * A BROKEN APP IS AN ACCUSATION UNTIL IT IS ATTRIBUTED.
 *
 * `docs/UNITS.md`'s U21 names this as its third silent break, and it is the sharp one: a
 * naive app with three features missing reads as *"they wrote a broken app"* unless every
 * missing feature carries, on screen, the agent that reported it done, its intent id, its
 * patch, and the file where the change is not. Without that link the naive lane is an
 * assertion rather than evidence, and `02` A7 is not satisfied by a page that is merely
 * correct.
 *
 * Until now that requirement existed **only as prose in a document**. Nothing produced the
 * attribution and nothing checked for it — which is the failure mode CLAUDE.md names
 * outright: *"Do not assert in a comment or a doc what the tests do not check. If a comment
 * claims an invariant, there is a test for it or the comment is a lie."*
 *
 * Written before U21's runner exists, per `spec/11-SHIP-LOOP.md`: the invariant's test comes
 * first and must fail before the implementation does. What the runner has to hand over is
 * therefore fixed here rather than discovered later — `WorkStep` is the whole contract, and
 * it is three fields plus a verdict.
 *
 * **The fixtures are the real ones.** `bench/fixtures/src/orders/repository.ts` with C1, C2
 * and C3 applied is the tree arbitration produces; the same three applied to a shared
 * snapshot is the tree last-write-wins produces. `test/patches.test.ts` already proves those
 * two trees differ by exactly two changes. This file proves the difference can be *named*.
 */
import { describe, expect, it } from 'vitest';

import { CONTENDED_FILE, patchesFor } from '../bench/demo-workload.js';
import {
  attributeFeatures,
  unattributableLosses,
  type Feature,
  type FeatureAttribution,
  type WorkStep,
} from '../src/demo/attribution.js';
import { applyPatch, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

const CONTENDERS = ['C1', 'C2', 'C3'] as const;

/** One feature per committed patch — the unit a judge sees present or missing. */
const FEATURES: Feature[] = CONTENDERS.flatMap((id) =>
  patchesFor(id).map((patch) => ({ id, patch })),
);

function baseline(): FileTree {
  return loadFixtureTree([CONTENDED_FILE]);
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
 * Last-write-wins: every agent reads the *same* snapshot and writes its own back, so the
 * final tree carries only the last agent's change. `06` §2 defines the arm this way and
 * `test/patches.test.ts` pins that exactly one of the three survives.
 */
function naiveTree(): FileTree {
  const shared = baseline();
  let saved = shared;
  for (const id of CONTENDERS) {
    let mine = shared;
    for (const patch of patchesFor(id)) mine = applyPatch(mine, patch);
    saved = mine;
  }
  return saved;
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

function records(steps: readonly WorkStep[] = STEPS): FeatureAttribution[] {
  return attributeFeatures({
    features: FEATURES,
    cortex: cortexTree(),
    naive: naiveTree(),
    steps,
  });
}

describe('every feature is accounted for in both apps', () => {
  it('returns one record per feature, each naming the file it belongs to', () => {
    const all = records();

    expect(all).toHaveLength(FEATURES.length);
    for (const record of all) {
      expect(record.file).toBe(record.patch.file);
      expect(FEATURES.some((f) => f.id === record.feature)).toBe(true);
    }
  });

  /**
   * The non-vacuity guard, and it has to come first. The assertion this file exists for is
   * "every loss is attributable"; over an empty set of losses that is true and worthless.
   * So the shape of the two trees is pinned here: three features in one app, one in the
   * other, which is `test/patches.test.ts`'s result restated as features rather than hunks.
   */
  it('finds three features in the CORTEX app and one in the naive app', () => {
    const all = records();

    expect(all.filter((r) => r.inCortex)).toHaveLength(3);
    expect(all.filter((r) => r.inNaive)).toHaveLength(1);
    expect(all.filter((r) => r.inCortex && !r.inNaive)).toHaveLength(2);
  });
});

describe('a missing feature is evidence only if it is attributable', () => {
  /**
   * THE ASSERTION THE UNIT TURNS ON.
   *
   * Every feature present under arbitration and absent without it must carry complete
   * attribution: a named agent, a real intent id, the patch, and the file. No nulls, and no
   * intent id that the run's own steps do not contain.
   */
  it('attributes every feature the naive lane lost to an agent, an intent and a patch', () => {
    const all = records();
    const lost = all.filter((r) => r.inCortex && !r.inNaive);

    expect(lost.length).toBeGreaterThan(0);

    for (const record of lost) {
      expect(record.agent, `${record.feature} has no agent`).not.toBeNull();
      expect(record.intentId, `${record.feature} has no intent id`).not.toBeNull();
      expect(
        STEPS.some((step) => step.intentId === record.intentId),
        `${record.feature} names an intent id this run never minted`,
      ).toBe(true);
      expect(record.patch.replace.length).toBeGreaterThan(0);
      expect(record.file).toBe(record.patch.file);
    }

    expect(unattributableLosses(all, STEPS)).toEqual([]);
  });

  /**
   * The page must not be able to show "this feature is missing" over a blank agent column.
   * A loss whose task no agent ever reported done is exactly that, and it is caught rather
   * than rendered.
   */
  it('refuses a loss that no agent reported done', () => {
    const silent = STEPS.filter((step) => step.taskId !== 'C1');
    const all = records(silent);
    const flagged = unattributableLosses(all, silent);

    expect(flagged.map((r) => r.feature)).toContain('C1');
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
   * `step.reported === 'done'` from `attributeFeatures` left all six tests green, because
   * every step in the fixture reported `done` and the test above deletes the step rather
   * than changing its verdict. The filter was correct and untested; this is the test.
   */
  it('refuses a loss whose agent reported something other than done', () => {
    const deduped: WorkStep[] = STEPS.map((step) =>
      step.taskId === 'C1' ? { ...step, reported: 'deduped' } : step,
    );
    const all = records(deduped);

    const c1 = all.find((r) => r.feature === 'C1')!;
    expect(c1.inCortex && !c1.inNaive).toBe(true);
    expect(c1.agent).toBeNull();
    expect(c1.intentId).toBeNull();
    expect(unattributableLosses(all, deduped).map((r) => r.feature)).toContain('C1');
  });

  /**
   * An intent id is attribution only if the run minted it. A record carrying a well-formed
   * id that appears in no step is a page inventing its own evidence, and it is the one
   * failure a null check cannot see.
   */
  it('refuses an intent id that appears in no step of the run', () => {
    const all = records();
    const lost = all.find((r) => r.inCortex && !r.inNaive)!;
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
    const all = records();
    const kept = all.filter((r) => r.inCortex && r.inNaive);

    expect(kept.length).toBeGreaterThan(0);
    expect(unattributableLosses(kept, [])).toEqual([]);
  });
});
