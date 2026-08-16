/**
 * WHO LOST IT — turning a broken app into evidence instead of an accusation.
 *
 * Since 2026-08-13 the demo's agents build a small orders dashboard and the page renders
 * **both** final apps side by side. One of them is missing features. `docs/UNITS.md`'s U21
 * names the hazard that creates: a broken app reads as *"they wrote a broken app"* unless
 * every missing feature is attributable on screen — the agent that reported it done, its
 * intent id, and the file where the work is not. Without that link the naive lane is an
 * assertion rather than evidence, and `02` A7 is not satisfied by a page that is merely
 * correct.
 *
 * This module is that link. It computes nothing about coordination and decides nothing about
 * the run; it takes two finished file trees and what the lane's agents said they did, and it
 * answers one question per feature: is it there, and if not, who said it was?
 *
 * ## PRESENCE IS DECIDED BY RUNNING THE APP, NOT BY FINDING A STRING
 *
 * Until 2026-08-16 a feature was "in" a tree when that tree's file **contained the committed
 * patch's replacement text**. That was exact and cheap while every hunk was committed, and it
 * stopped being either the moment `src/demo/author.ts` let a model write the code: the model
 * implements the same ticket in its own words, none of the committed text is in the file, every
 * feature reads absent, and the page reports a fleet of lost writes that never happened. It
 * would have done so **silently**, with the suite green — which is the same failure shape U16b's
 * fabricated meters had, arriving from the other direction.
 *
 * So presence is a question asked of the running app, and this module does not know how to ask
 * it. `Feature.works` is supplied by the caller: hand it a probe that assembles the tree, runs
 * it, and calls the functions a judge would reach by clicking. The oracle that owns those
 * questions is `bench/demo-app/acceptance.ts`, and this file deliberately does **not** import
 * it — `test/acceptance.test.ts` fences that module out of every non-test module so that a
 * prompt builder can never hand the corpus's own scoring to the thing being scored. Injection is
 * what keeps both properties: the probe is behavioural, and the fence holds.
 *
 * ## WHAT THIS COVERS, AND WHAT IT CANNOT
 *
 * **Interlock 3 of five, and no more.** Four of the five interlocks leave every patch present in
 * both trees — they are cross-module compositions, not absences — so `inCortex && !inNaive` is
 * correctly false for all of them however presence is decided. Attribution for those needs a
 * second axis, *which two correct changes compose wrongly*, and no code has it. Do not present
 * this module's output as complete attribution; `docs/UNITS.md` carries the table under U21.
 *
 * **No SQL here, and there must not be.** `scripts/gate-mechanical.sh` keeps statements inside
 * `src/memory/` and `src/db/`.
 */
import type { FileTree } from './patches.js';

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

/**
 * What a probe answers.
 *
 * `error` is a third verdict rather than a false, because a tree that *throws* — a lane that
 * lost a whole file — is a different fact from a tree that answers wrongly, and the page must
 * not report the first as the second. `observed` is the evidence a reader can check; a bare
 * boolean is an assertion they would have to take on trust.
 *
 * Structurally what `bench/demo-app/acceptance.ts`'s `CheckResult` already is, so a caller that
 * may import the oracle can pass `check.run` straight in.
 */
export interface FeaturePresence {
  verdict: 'pass' | 'fail' | 'error';
  observed: string;
}

/** Runs the tree and reports whether the feature is in it. Never inspects source text. */
export type FeatureProbe = (tree: FileTree) => FeaturePresence;

/** One visible feature: a ticket, and the question that decides whether it was delivered. */
export interface Feature {
  /** The ticket id, as the workload numbers it. */
  id: string;
  /** One line in the terms a reader of the page would use. */
  title: string;
  /**
   * The files this ticket's work belongs in — what the page points at when the feature is
   * missing. Descriptive only: nothing here decides presence from a file's contents.
   */
  files: readonly string[];
  works: FeatureProbe;
}

/** One row of the page's attribution panel. */
export interface FeatureAttribution {
  /** The ticket id. */
  feature: string;
  title: string;
  /** The agent that reported this feature done, or `null` if none did. */
  agent: string | null;
  /** That agent's intent id, or `null` if it never held one. */
  intentId: string | null;
  /** Where the work belongs, and where it is not. */
  files: readonly string[];
  /** What the probe saw in each lane — the evidence, not a restatement of the verdict. */
  cortex: FeaturePresence;
  naive: FeaturePresence;
  inCortex: boolean;
  inNaive: boolean;
}

export interface AttributionInput {
  features: readonly Feature[];
  /** The CORTEX lane's final tree. */
  cortex: FileTree;
  /** The NAIVE lane's final tree. */
  naive: FileTree;
  /**
   * The **naive** lane's steps. That lane is the one the panel accuses, so its agents are
   * the ones who must be named; borrowing the cortex lane's steps would attribute the loss
   * to an agent whose work is still there.
   */
  steps: readonly WorkStep[];
}

/**
 * Runs one probe against one tree, and turns a throw into the `error` verdict.
 *
 * The oracle's own checks already do this. A caller's home-made probe may not, and a page that
 * threw here would be an error page on the path behind the run button, which `04` §5 invariant 1
 * forbids outright.
 */
function presence(probe: FeatureProbe, tree: FileTree): FeaturePresence {
  try {
    const answer = probe(tree);
    return { verdict: answer.verdict, observed: answer.observed };
  } catch (error) {
    return {
      verdict: 'error',
      observed: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * One record per feature, saying whether each lane has it and who said it did.
 *
 * Never throws for a missing file, a tree that does not run, or a missing step. A lane that
 * lost a whole file still has to render, and a feature nobody claimed still has to appear — as
 * an unattributed row that `unattributableLosses` will refuse, rather than as an exception.
 */
export function attributeFeatures(input: AttributionInput): FeatureAttribution[] {
  return input.features.map((feature) => {
    const claimed = input.steps.find(
      (step) => step.taskId === feature.id && step.reported === 'done',
    );

    const cortex = presence(feature.works, input.cortex);
    const naive = presence(feature.works, input.naive);

    return {
      feature: feature.id,
      title: feature.title,
      agent: claimed?.agent ?? null,
      intentId: claimed?.intentId ?? null,
      files: feature.files,
      cortex,
      naive,
      inCortex: cortex.verdict === 'pass',
      inNaive: naive.verdict === 'pass',
    };
  });
}

/**
 * A feature arbitration delivered and last-write-wins destroyed. The rows the page accuses
 * somebody of.
 *
 * A lane whose tree does not run at all fails this rather than passing it, because `error` is
 * not `pass` — which is the right way round: an app that will not start has not delivered the
 * feature, and the row still has to name whoever reported it.
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
