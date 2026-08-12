/**
 * WHO LOST IT — turning a broken app into evidence instead of an accusation.
 *
 * Since 2026-08-13 the demo's agents build a small orders dashboard and the page renders
 * **both** final apps side by side. One of them is missing features. `docs/UNITS.md`'s U21
 * names the hazard that creates: a broken app reads as *"they wrote a broken app"* unless
 * every missing feature is attributable on screen — the agent that reported it done, its
 * intent id, its patch, and the file where the change is not. Without that link the naive
 * lane is an assertion rather than evidence, and `02` A7 is not satisfied by a page that is
 * merely correct.
 *
 * This module is that link, and it is deliberately the smallest thing that can be checked
 * before U21's runner exists. It computes nothing about coordination and decides nothing
 * about the run; it takes two finished file trees and what the lane's agents said they did,
 * and it answers one question per feature: is it there, and if not, who said it was?
 *
 * **Presence is measured against the patch, not against a description of it.** A feature is
 * in a tree when that tree's file contains the patch's replacement text. The three demo
 * patches rewrite disjoint regions (`test/patches.test.ts` asserts they do), so one patch
 * landing never erases another's text and the test is exact rather than heuristic. The
 * alternative — a per-feature marker string maintained by hand — is a second place for the
 * corpus to drift out of the workload, and drift there produces a page that quietly
 * mis-attributes rather than one that fails.
 *
 * **No SQL here, and there must not be.** `scripts/gate-mechanical.sh` keeps statements
 * inside `src/memory/` and `src/db/`. The patches whose bodies are fixture source live in
 * `bench/demo-workload.ts` beside the fixtures they target; this file only ever reads their
 * text.
 */
import type { Patch } from './patches.js';

/**
 * What one lane's agent did with one task, as the runner must hand it over.
 *
 * Three fields and a verdict, because attribution needs no more than that and every extra
 * field is one the runner could supply wrongly without anything noticing. `intentId` is
 * nullable on purpose: an agent that never reached the arbitration transaction has no
 * intent, and pretending otherwise is exactly the invented evidence this module exists to
 * refuse.
 */
export interface WorkStep {
  /** The ticket, as `bench/demo-workload.ts` numbers it — `C1`, `P6a`. */
  taskId: string;
  agent: string;
  /** The intent this agent held, or `null` if it never held one. */
  intentId: string | null;
  /**
   * What the agent reported. Only `done` claims a feature was delivered, and only a `done`
   * can be contradicted by the app not having it — the rest are outcomes that *explain* an
   * absence rather than accusing anyone of it.
   */
  reported: 'done' | 'deduped' | 'blocked' | 'abandoned' | 'contended';
}

/** One visible feature: a ticket and the committed change that delivers it. */
export interface Feature {
  id: string;
  patch: Patch;
}

/** One row of the page's attribution panel. */
export interface FeatureAttribution {
  /** The ticket id. */
  feature: string;
  /** The agent that reported this feature done, or `null` if none did. */
  agent: string | null;
  /** That agent's intent id, or `null` if it never held one. */
  intentId: string | null;
  /** The committed change — the hunk a reader can compare against the file. */
  patch: Patch;
  /** The file the change belongs in, and where it is not. */
  file: string;
  inCortex: boolean;
  inNaive: boolean;
}

export interface AttributionInput {
  features: readonly Feature[];
  /** The CORTEX lane's final tree. */
  cortex: Record<string, string>;
  /** The NAIVE lane's final tree. */
  naive: Record<string, string>;
  /**
   * The **naive** lane's steps. That lane is the one the panel accuses, so its agents are
   * the ones who must be named; borrowing the cortex lane's steps would attribute the loss
   * to an agent whose work is still there.
   */
  steps: readonly WorkStep[];
}

function present(tree: Record<string, string>, patch: Patch): boolean {
  return tree[patch.file]?.includes(patch.replace) ?? false;
}

/**
 * One record per feature, saying whether each lane has it and who said it did.
 *
 * Never throws for a missing file or a missing step. A lane that lost a whole file still
 * has to render, and a feature nobody claimed still has to appear — as an unattributed row
 * that `unattributableLosses` will refuse, rather than as an exception on a page `04` §5
 * invariant 1 forbids an error on.
 */
export function attributeFeatures(input: AttributionInput): FeatureAttribution[] {
  return input.features.map((feature) => {
    const claimed = input.steps.find(
      (step) => step.taskId === feature.id && step.reported === 'done',
    );

    return {
      feature: feature.id,
      agent: claimed?.agent ?? null,
      intentId: claimed?.intentId ?? null,
      patch: feature.patch,
      file: feature.patch.file,
      inCortex: present(input.cortex, feature.patch),
      inNaive: present(input.naive, feature.patch),
    };
  });
}

/**
 * A feature arbitration delivered and last-write-wins destroyed. The rows the page accuses
 * somebody of.
 */
export function isLoss(record: FeatureAttribution): boolean {
  return record.inCortex && !record.inNaive;
}

/**
 * The losses that must not reach the screen: the ones whose attribution is incomplete.
 *
 * Empty is the requirement. Three ways a row fails it, and the third is the one a null
 * check cannot see:
 *
 * - no agent — the panel would accuse a blank,
 * - no intent id — the claim would be untraceable to the arbitration transaction,
 * - an intent id that `steps` does not contain — the page inventing its own evidence.
 *
 * That last check is why this takes `steps` rather than trusting the records: the records
 * `attributeFeatures` builds satisfy it by construction, and the ones a runner builds are
 * exactly the ones worth checking. A guard that only ever saw its own output would be
 * asserting that this file has no bugs, which is not the claim being made.
 *
 * Scoped to losses deliberately. A feature both lanes kept accuses nobody and needs no
 * agent; demanding one would fail every run for a reason the page is not making.
 */
export function unattributableLosses(
  records: readonly FeatureAttribution[],
  steps: readonly WorkStep[],
): FeatureAttribution[] {
  return records
    .filter(isLoss)
    .filter(
      (record) =>
        record.agent === null ||
        record.intentId === null ||
        !steps.some((step) => step.intentId === record.intentId),
    );
}
