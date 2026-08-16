/**
 * U21'S GATE — eleven tickets run to completion in both arms against the real cluster, with all
 * four beats observed.
 *
 *   npm run gate:workload            one run
 *   npm run gate:workload -- --runs 3   three runs, and a ledger of what differed between them
 *
 * That sentence is the unit's done-when, verbatim from design §11, and this script is the only
 * thing that can decide it. Everything it prints comes from the run: the beats are observed
 * moments rather than a script, the meters are read back out of the cluster, and the two apps at
 * the end are the trees the two lanes actually finished with.
 *
 * ## TWO GROUPS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
 *
 * **INVARIANTS** are what the mechanism guarantees on *every* run, whatever the agents write:
 * dedupe and the claim share one transaction, the cortex lane never has two agents in one file at
 * once, every ticket settles, every loss is attributable, both scopes stay inside the row cap.
 * A failure here is a regression and this script exits non-zero.
 *
 * **OBSERVATIONS** are true in distribution and may legitimately miss on a given run: which
 * interlocks fired, whether the naive lane lost a hunk this time, how much duplicate work it did.
 * They are reported with their real values and they **do not fail the gate**. Two of them were
 * already race-dependent before anything was model-authored — V51 recorded honest runs coming
 * back 15/17 when the naive lane's dedupe caught the racing P6 pair — and the split exists
 * because a gate that fails on those reports a regression that did not happen, while a gate that
 * stops asserting them proves nothing. Since `src/demo/author.ts` a model may author the code,
 * and then far more can vary honestly: an uninformed model can get the money representation right
 * by luck, and interlock 1 simply does not fire.
 *
 * **"Not observed" is not "broken", and the output must make that unmissable.**
 *
 * ## PROVING THE RUN IS NON-DETERMINISTIC RATHER THAN ASSERTING IT
 *
 * `--runs N` runs the whole workload N times against fresh scopes and prints a ledger of which
 * observations and which figures differed between them. That is the demonstrable form of the
 * claim: two runs of the same input produced different work. It defaults to **one** run and to
 * REPLAY, which reaches Bedrock for no reasoning at all — the coordination is what varies, and
 * races, dedupe timing and which hunk dies vary without spending a penny on tokens. The only
 * live model spend either way is Titan embeddings.
 *
 * **Two scopes per run, not one** (design §4.1). Each arm gets its own `repos` row carrying
 * `demo_expires_at`, so the isolation between the arms is row-level security rather than the
 * incidental "they happen to use different tables" it used to be. It also means each arm has its
 * own `DEMO_SESSION_ROW_CAP` budget, and finding the ceiling deliberately rather than in front of
 * a judge is design §12 item 3 — which this prints.
 *
 * **Beat 4 needs a running changefeed.** Consolidation is performed by the deployed sink reading
 * the cluster's own changefeed, so `npm run changefeed status` must show a running job or the
 * cortex lane's agents will honestly report that nothing was known. That is the correct behaviour
 * and this script says which happened rather than pretending.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder, byTransaction, type RecordedTransaction } from '../src/db/recorder.js';
import { Embedder } from '../src/embed/titan.js';
import { CLAIM_ACQUIRE_SQL, DEDUPE_CANDIDATE_SQL } from '../src/memory/propose.js';
import {
  attributeFeatures,
  unattributableLosses,
  type Feature,
  type FeatureProbe,
} from '../src/demo/attribution.js';
import { assembleApp } from '../src/demo/app-bundle.js';
import { behaviouralProbe, hasBehaviouralCheck, COMPOSITION_CHECKS } from '../src/demo/feature-probe.js';
import { runArm, ASSIGNMENT, type ArmResult } from '../src/demo/workload.js';
import { createDemoSessionPair, DEMO_SESSION_ROW_CAP, demoState } from '../src/memory/demo.js';
import { CONTENDED_FILE, DEMO_TASKS, type DemoTask } from '../bench/demo-workload.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

// ────────────────────────────────────────────────────────────────────────────────────────────
// The two kinds of claim this script makes
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A property that must hold on every run. A false one is a regression. */
interface Invariant {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * A property that holds in distribution. `seen: false` is a fact about this run, never a verdict
 * on the code — which is why it is a separate type rather than an `Invariant` with a flag.
 */
interface Observation {
  label: string;
  seen: boolean;
  detail: string;
}

/** An invariant this run could not decide, and why. Neither a pass nor a failure. */
interface NotEvaluated {
  label: string;
  why: string;
}

/** One value worth watching across runs. `null` is a value — "nothing to measure" — not a hole. */
type Figure = number | string | null;

interface RunReport {
  index: number;
  invariants: Invariant[];
  notEvaluated: NotEvaluated[];
  observations: Observation[];
  figures: Record<string, Figure>;
  ms: number;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Presence, and the one thing this script cannot do
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * **REPLAY-ONLY PRESENCE, and the precondition is checked rather than assumed.**
 *
 * `src/demo/attribution.ts` decides whether a feature is in a tree by *running the app* and takes
 * the question as a parameter. The questions live in `bench/demo-app/acceptance.ts`, and this
 * script now supplies them.
 *
 * **It supplied a text-exact rule for one afternoon, and the reason it no longer does is worth
 * keeping.** The oracle is fenced so an agent cannot read the checks it is graded against. The
 * first fence was a text scan over all of `src/`, `scripts/`, `bench/` and `infra/lambda/` for any
 * import of it — broader than the rule it enforces, and it forbade this script the one thing the
 * oracle exists for. What was left was "the reviewed hunk's replacement text is in the file",
 * which is exact while every hunk is replayed and **worthless** the moment a model authors the
 * code: the text is not there, every feature reads absent, and the run reports a fleet of losses
 * that never happened. That was handled by refusing to evaluate attribution at all on a
 * model-authored run — correct, and blind in exactly the case the probe is for.
 *
 * The fence is now around **the prompt** (`test/acceptance.test.ts`, mutation-tested by leaking
 * the oracle into `buildPrompt`), so everything downstream of the model may run it, and does.
 */

/**
 * One feature per ticket that carries code and that the oracle can decide.
 *
 * **The single-variant restriction is gone, and the behavioural probe is why.** Under the text
 * rule, a ticket with an informed variant was not a present-or-absent question: both lanes deliver
 * the feature differently, and testing the uninformed replacement text against a cortex tree
 * holding the informed one reported the *correctly informed* agent as having lost its work. A
 * behavioural check asks whether the feature works, which both correct variants satisfy —
 * `test/acceptance.test.ts` asserts exactly that, that both lanes' intended trees pass every
 * ticket check. So I3, C3 and R3 are now covered too.
 *
 * What is still **not** covered is unchanged and must not be overstated: this module reports a
 * feature that is *absent*. Interlocks 1 and 2 leave every patch present in both trees and fail by
 * *composition*, which is the second axis `docs/UNITS.md` describes and no code has. Those are the
 * oracle's COMPOSITION_CHECKS, reported as observations, not as attributed losses.
 */
const FEATURES: Feature[] = DEMO_TASKS.filter(
  (task) => task.patches.length > 0 && hasBehaviouralCheck(task.id),
).map((task) => ({
  id: task.id,
  title: task.statement,
  files: [...new Set(task.patches.map((patch) => patch.file))],
  works: behaviouralProbe(task.id),
}));

// ────────────────────────────────────────────────────────────────────────────────────────────
// Reading the transcript
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The recorder collapses whitespace before it stores a statement; this matches that. */
const collapse = (sql: string): string => sql.trim().replace(/\s+/g, ' ');

/**
 * The two statements invariant 1 is about, taken from the module that executes them rather than
 * re-typed here. If either query is ever edited, both this recognition and the execution move
 * together — a copy would go on recognising a statement the system had stopped sending, and the
 * invariant would report itself satisfied by nothing.
 */
const SIMILARITY_CHECK = collapse(DEDUPE_CANDIDATE_SQL);
const CLAIM_INSERT = collapse(CLAIM_ACQUIRE_SQL);

const holds = (txn: RecordedTransaction, sql: string): boolean =>
  txn.statements.some((statement) => statement.sql === sql);

function meterRows(result: ArmResult): string[] {
  const m = result.meter;
  const tokens = (value: number | null | undefined): string =>
    value === null || value === undefined ? 'TBD' : String(value);

  return [
    `duplicate work avoided   ${m.duplicateWorkAvoided}`,
    `duplicate work done      ${m.duplicateWorkDone}`,
    `writes lost              ${m.lostWrites}`,
    `blocked and re-planned   ${m.blockedAndReplanned}`,
    `findings recalled        ${m.findingsRecalled}`,
    `agents spared            ${m.agentsSpared}`,
    `dead ends walked         ${m.deadEndsWalked}`,
    `conflicting edits        ${m.conflictingEdits}`,
    `file collisions          ${m.fileCollisions}`,
    `live embedding calls     ${m.embeddingCalls}`,
    `claim p50 (ms)           ${m.claimP50Ms ?? '—'}`,
    `serialization retries    ${m.serializationRetries}`,
    `hunks the model wrote    ${m.hunksAuthoredByModel ?? 'TBD'}`,
    `hunks that fell back     ${m.hunksFallenBack ?? 'TBD'}`,
    `hunks replayed           ${m.hunksReplayed ?? 'TBD'}`,
    `model input tokens       ${tokens(m.modelInputTokens)}`,
    `model output tokens      ${tokens(m.modelOutputTokens)}`,
    `wasted tokens            ${tokens(m.wastedTokens)}`,
  ];
}

/** Which agent's write landed on the contended file first — a different one most runs. */
function firstIn(result: ArmResult, file: string): string {
  const event = result.events.find(
    (one) =>
      one.phase === 'patched' && ((one.detail?.['files'] as string[] | undefined) ?? []).includes(file),
  );
  return event?.agent ?? 'nobody';
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// One run
// ────────────────────────────────────────────────────────────────────────────────────────────

async function runOnce(index: number, verbose: boolean, embed: (t: string) => Promise<number[]>): Promise<RunReport> {
  const startedAt = Date.now();

  const { scopes } = await createDemoSessionPair();
  console.log(`  cortex scope ${scopes.cortex}`);
  console.log(`  naive  scope ${scopes.naive}`);

  const cortexRecorder = new StatementRecorder();
  const naiveRecorder = new StatementRecorder();

  const cortexStarted = Date.now();
  const cortex = await runArm({
    sessionId: scopes.cortex,
    arm: 'cortex',
    embed,
    recorder: cortexRecorder,
  });
  const cortexMs = Date.now() - cortexStarted;

  const naiveStarted = Date.now();
  const naive = await runArm({
    sessionId: scopes.naive,
    arm: 'naive',
    embed,
    recorder: naiveRecorder,
  });
  const naiveMs = Date.now() - naiveStarted;

  // ---- The journey, so a reader can see what happened rather than trust a verdict ----
  // Printed only for a single run: three runs of ~90 events each is a wall nobody reads, and the
  // point of `--runs` is the ledger at the end rather than the transcript.
  if (verbose) {
    for (const result of [cortex, naive]) {
      console.log(`\n${result.arm.toUpperCase()} — ${result.events.length} events`);
      for (const event of result.events) {
        const detail = event.detail ? ` ${JSON.stringify(event.detail).slice(0, 150)}` : '';
        console.log(
          `  ${String(event.at).padStart(6)}ms  ${event.agent}  ${event.taskId.padEnd(4)} ` +
            `${event.phase.padEnd(10)}${detail}`,
        );
      }
    }
  }

  console.log('\n  METER');
  const cortexRows = meterRows(cortex);
  const naiveRows = meterRows(naive);
  console.log(`    ${'metric'.padEnd(25)} ${'CORTEX'.padEnd(10)} NAIVE`);
  for (const [row, cortexRow] of cortexRows.entries()) {
    const label = cortexRow.slice(0, 25);
    console.log(
      `    ${label} ${cortexRow.slice(25).trim().padEnd(10)} ${naiveRows[row]!.slice(25).trim()}`,
    );
  }
  console.log(`\n    wall clock: cortex ${cortexMs}ms, naive ${naiveMs}ms`);

  // ---- Attribution — one row per feature, and every loss must name somebody ----
  const authorshipIsReplay =
    (cortex.meter.hunksAuthoredByModel ?? 0) === 0 &&
    (cortex.meter.hunksFallenBack ?? 0) === 0 &&
    (naive.meter.hunksAuthoredByModel ?? 0) === 0 &&
    (naive.meter.hunksFallenBack ?? 0) === 0;

  const records = attributeFeatures({
    features: FEATURES,
    cortex: cortex.tree,
    naive: naive.tree,
    steps: naive.steps,
  });
  const losses = records.filter((record) => record.inCortex && !record.inNaive);
  const surplus = records.filter((record) => !record.inCortex && record.inNaive);
  const unattributed = unattributableLosses(records, naive.steps);

  console.log('\n  ATTRIBUTION');
  for (const record of losses) {
    console.log(
      `    lost  ${record.feature.padEnd(4)} ${record.files.join(', ').padEnd(30)} ` +
        `reported done by ${record.agent} (intent ${record.intentId?.slice(0, 8)}) — ${record.naive.observed}`,
    );
  }
  for (const record of surplus) {
    console.log(`    extra ${record.feature.padEnd(4)} ${record.files.join(', ')} — naive did work cortex did not`);
  }
  if (losses.length === 0 && surplus.length === 0) console.log('    nothing lost and nothing extra this run');

  // ---- Row budgets, per scope. Design §12 item 3 ----
  const cortexState = await demoState(scopes.cortex);
  const naiveState = await demoState(scopes.naive);

  console.log(`\n  ROW BUDGET (per scope, cap ${DEMO_SESSION_ROW_CAP})`);
  console.log(`    cortex  ${cortexState?.rows.used} used, ${cortexState?.rows.remaining} left`);
  console.log(`    naive   ${naiveState?.rows.used} used, ${naiveState?.rows.remaining} left`);

  const cortexTxns = byTransaction(cortexRecorder.statements);
  const naiveTxns = byTransaction(naiveRecorder.statements);
  console.log(
    `\n  TRANSACTIONS  cortex ${cortexTxns.length}, naive ${naiveTxns.length}` +
      `  (statements: ${cortexRecorder.statements.length} / ${naiveRecorder.statements.length})`,
  );

  // ══ INVARIANTS ══════════════════════════════════════════════════════════════════════════
  const invariants: Invariant[] = [];
  const notEvaluated: NotEvaluated[] = [];
  const invariant = (label: string, ok: boolean, detail = ''): void => {
    invariants.push({ label, ok, detail });
  };

  const settled = (result: ArmResult): number => new Set(result.steps.map((s) => s.taskId)).size;

  invariant('every ticket reached a terminal outcome in CORTEX',
    settled(cortex) === DEMO_TASKS.length, `${settled(cortex)}/${DEMO_TASKS.length}`);
  invariant('every ticket reached a terminal outcome in NAIVE',
    settled(naive) === DEMO_TASKS.length, `${settled(naive)}/${DEMO_TASKS.length}`);

  /**
   * INVARIANT 1, read off the live transcript rather than off a test fixture. If a similarity
   * check and a claim insert ever land in different transactions, the project's thesis is
   * falsified by its own code — so the gate that runs the real thing has to look.
   */
  const cortexTogether = cortexTxns.filter((txn) => holds(txn, SIMILARITY_CHECK) && holds(txn, CLAIM_INSERT));
  const naiveTogether = naiveTxns.filter((txn) => holds(txn, SIMILARITY_CHECK) && holds(txn, CLAIM_INSERT));

  // Non-vacuity first: a statement this script failed to recognise would make both of the next
  // two answers meaningless while looking like a clean pass and a clean refusal.
  const sawBoth = (txns: RecordedTransaction[]): boolean =>
    txns.some((txn) => holds(txn, SIMILARITY_CHECK)) && txns.some((txn) => holds(txn, CLAIM_INSERT));
  invariant('both statements were recognised in both transcripts',
    sawBoth(cortexTxns) && sawBoth(naiveTxns),
    'if this fails the two rows below are answering about nothing');
  invariant('CORTEX ran the similarity check and the claim insert in ONE transaction',
    cortexTogether.length > 0, `${cortexTogether.length} transaction(s) hold both`);
  invariant('NAIVE ran them in two, which is the lane it is compared against',
    naiveTogether.length === 0, `${naiveTogether.length} transaction(s) hold both`);

  /**
   * Arbitration is what a file collision is: two agents holding one file at once. The cortex lane
   * claims the files the work touches, so it must have none — and if it ever does, invariant 1 is
   * not doing what this whole project claims it does.
   */
  invariant('the CORTEX lane had no two agents in one file at once',
    cortex.meter.fileCollisions === 0, `${cortex.meter.fileCollisions}`);

  /**
   * U23. `06` §3's metric is line-granular and this workload's collisions are mostly not — C1, C2
   * and C3 edit disjoint regions of one file (V51) — so the two figures are checked against each
   * other rather than against a target. What must hold is the relationship that makes publishing
   * both honest: every line overlap is also a file collision, so the second can never be smaller.
   */
  invariant('file collisions are never fewer than conflicting edits',
    naive.meter.fileCollisions >= naive.meter.conflictingEdits &&
      cortex.meter.fileCollisions >= cortex.meter.conflictingEdits,
    `naive ${naive.meter.fileCollisions}/${naive.meter.conflictingEdits}, ` +
      `cortex ${cortex.meter.fileCollisions}/${cortex.meter.conflictingEdits}`);

  /**
   * The non-vacuity guard for the two figures above, and the reason they are trustworthy at zero.
   * A collision count of 0 computed over an empty span list is indistinguishable on screen from a
   * lane that genuinely never collided, and that is exactly the shape U16b's fabrication took — a
   * number that looked measured and was not.
   */
  invariant('the collision figures were computed over located hunks, not over nothing',
    cortex.spans.length > 0 && naive.spans.length > 0,
    `cortex ${cortex.spans.length} hunks placed, naive ${naive.spans.length}`);

  /** The same rule applied to the authorship figures: a count over an empty list renders alike. */
  invariant('the authorship figures were counted over work that happened',
    (cortex.authorings?.length ?? 0) > 0 && (naive.authorings?.length ?? 0) > 0,
    `cortex ${cortex.authorings?.length ?? 0} authored tickets, naive ${naive.authorings?.length ?? 0}`);

  /**
   * `06` §6's line, checked rather than commented: on a run where nobody called a model, the token
   * figures must read TBD. A bare 0 claims somebody measured nothing spent.
   */
  if (authorshipIsReplay) {
    invariant('a REPLAY run reports its token spend as TBD rather than as nought',
      cortex.meter.wastedTokens === null && cortex.meter.modelInputTokens === null &&
        naive.meter.wastedTokens === null && naive.meter.modelInputTokens === null);
  } else {
    invariant('a LIVE run reports a measured token spend rather than TBD',
      cortex.meter.modelInputTokens !== null && naive.meter.modelInputTokens !== null,
      `cortex in ${cortex.meter.modelInputTokens} out ${cortex.meter.modelOutputTokens}, ` +
        `naive in ${naive.meter.modelInputTokens} out ${naive.meter.modelOutputTokens}`);
  }

  /**
   * Attribution's precondition, checked before its result is believed. Every `done` step must
   * carry an intent id the run itself minted, or no loss could ever be attributed to it — and
   * unlike the row below, this holds whoever wrote the code.
   */
  const doneSteps = naive.steps.filter((step) => step.reported === 'done');
  invariant('every NAIVE agent that reported done holds an intent the run minted',
    doneSteps.length > 0 && doneSteps.every((step) => step.intentId !== null),
    `${doneSteps.length} done step(s)`);

  /**
   * **An invariant again on every run, not only on replayed ones.**
   *
   * This was gated behind `authorshipIsReplay` and reported as *not evaluated* whenever a model
   * wrote anything — correct while the probe was text-exact, and blind in the one case that
   * matters. The probe now asks whether the feature *works*, which does not depend on who typed
   * it, so the gate decides it whoever authored the run.
   */
  invariant('every loss is attributable', unattributed.length === 0,
    unattributed.length === 0
      ? `${losses.length} loss(es) named`
      : unattributed.map((record) => record.feature).join(', '));

  invariant('both scopes stayed inside the row cap',
    (cortexState?.rows.used ?? 0) < DEMO_SESSION_ROW_CAP &&
      (naiveState?.rows.used ?? 0) < DEMO_SESSION_ROW_CAP,
    `cortex ${cortexState?.rows.used}, naive ${naiveState?.rows.used}`);
  invariant('both arms produced an app the state route can serve',
    Object.keys(cortex.tree).length > 0 && Object.keys(naive.tree).length > 0,
    `cortex ${Object.keys(cortex.tree).length} files, naive ${Object.keys(naive.tree).length}`);
  invariant('both apps assemble',
    assembleApp(cortex.tree).length > 0 && assembleApp(naive.tree).length > 0);

  // ══ OBSERVATIONS ════════════════════════════════════════════════════════════════════════
  const observations: Observation[] = [];
  const observe = (label: string, seen: boolean, detail = ''): void => {
    observations.push({ label, seen, detail });
  };

  observe('beat 1 — recall returned a finding', cortex.beats.recall,
    `${cortex.meter.findingsRecalled} finding(s) handed to an agent`);
  observe('beat 2 — a proposal was deduped', cortex.beats.dedupe,
    `${cortex.meter.duplicateWorkAvoided} avoided`);
  /**
   * Beat 3 has **two honest endings and the run picks one**, which the first two gate runs showed
   * by picking a different one each time.
   *
   * Three agents propose for one file at once. A loser whose transaction commits finds the key
   * held, is told who holds it, and re-plans — that is invariant 3, and it is the evidence this
   * demo wants. A loser whose transaction *conflicts* instead gets a 40001, `withRetry` backs it
   * off, and by the time it returns the holder has closed and released, so it is granted with no
   * block ever recorded. Both are the mechanism working and neither is arranged.
   */
  observe('beat 3 — two agents wanted one file',
    cortex.meter.blockedAndReplanned > 0 || cortex.meter.serializationRetries > 0,
    cortex.meter.blockedAndReplanned > 0
      ? `${cortex.meter.blockedAndReplanned} blocked and told the holder`
      : `no block: the losers hit ${cortex.meter.serializationRetries} SERIALIZABLE retries and were granted after the holder released`);
  observe('beat 4 — a finding this run produced came back on recall', cortex.beats.consolidate,
    cortex.beats.consolidate ? '' : 'is the changefeed running? `npm run changefeed status`');

  observe('the naive lane lost work the cortex lane kept', losses.length > 0,
    `${losses.length} feature(s)`);
  observe('the naive lane did duplicate work the cortex lane avoided',
    naive.meter.duplicateWorkDone > cortex.meter.duplicateWorkDone,
    `${naive.meter.duplicateWorkDone} vs ${cortex.meter.duplicateWorkDone}`);
  observe('an agent was spared by what the fleet already knew', cortex.meter.agentsSpared > 0,
    `${cortex.meter.agentsSpared}`);
  observe('the naive lane walked a dead end the cortex lane did not',
    naive.meter.deadEndsWalked > cortex.meter.deadEndsWalked,
    `${naive.meter.deadEndsWalked} vs ${cortex.meter.deadEndsWalked}`);

  /**
   * **The interlocks are decided by running both apps, not by looking for reviewed text.**
   *
   * They were text markers until 2026-08-16 — `naiveQuote.includes('2.99')` and the like — which
   * is exact while every hunk is replayed and meaningless the moment a model writes the code. The
   * markers were guarded by an authorship check that reported them "not decidable" on precisely
   * the runs the demo is now about, which is honest and useless.
   *
   * `bench/demo-app/acceptance.ts`'s `COMPOSITION_CHECKS` decide them properly: each runs the
   * composed tree and asks whether the *behaviour* is right. An interlock **fired** when the check
   * fails in the naive tree and passes in the cortex one — which is the demo's whole claim,
   * executable, and true whoever wrote the code.
   *
   * The `observed` string comes from the check, so what prints is evidence rather than a
   * restatement of the verdict: "shipping renders £0.03; the tariff for 0.75kg is £3.37".
   */
  const compositions = COMPOSITION_CHECKS.map((check) => ({
    id: check.id,
    title: check.title,
    cortex: check.run(cortex.tree),
    naive: check.run(naive.tree),
  }));

  for (const one of compositions) {
    const fired = one.cortex.verdict === 'pass' && one.naive.verdict !== 'pass';
    observe(
      `${one.id} — ${one.title}`,
      fired,
      fired
        ? `naive: ${one.naive.observed}`
        : one.cortex.verdict !== 'pass'
          ? `cortex did not deliver it either — ${one.cortex.observed}`
          : `both lanes got it right this run — ${one.naive.observed}`,
    );
  }

  const spared = cortex.events.find((event) => event.phase === 'spared');
  observe('interlock 5 — the spared agent is named, with what spared it',
    spared !== undefined && spared.detail?.['fact'] !== undefined,
    spared ? String(spared.detail?.['by'] ?? '') : '');

  // ══ FIGURES — what the ledger watches across runs ═══════════════════════════════════════
  const figures: Record<string, Figure> = {
    'cortex · blocked and re-planned': cortex.meter.blockedAndReplanned,
    'cortex · serialization retries': cortex.meter.serializationRetries,
    'cortex · claim p50 (ms)': cortex.meter.claimP50Ms,
    'cortex · duplicate work avoided': cortex.meter.duplicateWorkAvoided,
    'cortex · findings recalled': cortex.meter.findingsRecalled,
    'cortex · fleet events': cortex.events.length,
    [`cortex · first write to ${CONTENDED_FILE}`]: firstIn(cortex, CONTENDED_FILE),
    'naive · duplicate work done': naive.meter.duplicateWorkDone,
    'naive · writes lost': naive.meter.lostWrites,
    'naive · conflicting edits': naive.meter.conflictingEdits,
    'naive · file collisions': naive.meter.fileCollisions,
    'naive · fleet events': naive.events.length,
    [`naive · first write to ${CONTENDED_FILE}`]: firstIn(naive, CONTENDED_FILE),
    'naive · features lost': losses.length,
  };

  return {
    index,
    invariants,
    notEvaluated,
    observations,
    figures,
    ms: Date.now() - startedAt,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Printing
// ────────────────────────────────────────────────────────────────────────────────────────────

function printReport(report: RunReport): void {
  const passed = report.invariants.filter((one) => one.ok).length;

  console.log('\n  INVARIANTS — these must hold on every run; a failure here is a regression');
  for (const one of report.invariants) {
    console.log(`    ${one.ok ? 'PASS' : 'FAIL'}  ${one.label}${one.detail ? `  — ${one.detail}` : ''}`);
  }
  for (const one of report.notEvaluated) {
    console.log(`    ????  ${one.label}  — NOT EVALUATED: ${one.why}`);
  }

  console.log('\n  OBSERVATIONS — true in distribution; a miss on one run is NOT a failure');
  for (const one of report.observations) {
    console.log(
      `    ${one.seen ? 'SEEN    ' : 'NOT SEEN'}  ${one.label}${one.detail ? `  — ${one.detail}` : ''}`,
    );
  }

  const seen = report.observations.filter((one) => one.seen).length;
  console.log(
    `\n  INVARIANTS ${passed}/${report.invariants.length}` +
      (report.notEvaluated.length > 0 ? ` (${report.notEvaluated.length} not evaluated)` : '') +
      `   ·   OBSERVED ${seen}/${report.observations.length}   ·   ${report.ms}ms`,
  );
}

/**
 * The ledger: what differed between runs of the same input.
 *
 * This is the demonstrable form of "the run is not a recording". A judge does not have to take
 * the claim on trust — two runs are shown side by side and the differences are named. Nothing
 * here can fail the gate: identical runs are a fact about the runs, not a defect.
 */
function printLedger(reports: readonly RunReport[]): void {
  const columns = reports.map((report) => `run${report.index}`);
  const shownFigure = (value: Figure): string => (value === null ? 'TBD' : String(value));

  // Wide enough for the widest thing that goes in the column, values included: an agent id
  // truncated into its neighbour reads as one word and hides the very difference this prints.
  const width =
    Math.max(
      ...columns.map((one) => one.length),
      ...reports.flatMap((report) => Object.values(report.figures).map((one) => shownFigure(one).length)),
    ) + 2;
  const labelWidth = Math.max(
    ...reports[0]!.observations.map((one) => one.label.length),
    ...Object.keys(reports[0]!.figures).map((one) => one.length),
  ) + 2;

  console.log('\n\n══ NON-DETERMINISM — did the same input produce different work? ══════════════\n');
  console.log(`  ${'observation'.padEnd(labelWidth)}${columns.map((one) => one.padStart(width)).join('')}`);

  let variedObservations = 0;
  for (const [index, one] of reports[0]!.observations.entries()) {
    const marks = reports.map((report) => (report.observations[index]?.seen ? '✓' : '·'));
    const varied = new Set(marks).size > 1;
    if (varied) variedObservations += 1;
    console.log(
      `  ${one.label.padEnd(labelWidth)}` +
        marks.map((mark) => mark.padStart(width)).join('') +
        (varied ? '   ← differed' : ''),
    );
  }

  console.log(`\n  ${'figure'.padEnd(labelWidth)}${columns.map((one) => one.padStart(width)).join('')}`);
  let variedFigures = 0;
  for (const key of Object.keys(reports[0]!.figures)) {
    const shown = reports.map((report) => shownFigure(report.figures[key] ?? null));
    const varied = new Set(shown).size > 1;
    if (varied) variedFigures += 1;
    console.log(
      `  ${key.padEnd(labelWidth)}` +
        shown.map((one) => one.padStart(width)).join('') +
        (varied ? '   ← differed' : ''),
    );
  }

  const total = reports[0]!.observations.length + Object.keys(reports[0]!.figures).length;
  const varied = variedObservations + variedFigures;
  console.log(
    `\n  ${varied} of ${total} watched values differed across ${reports.length} runs ` +
      `(${variedObservations} observation(s), ${variedFigures} figure(s)).`,
  );
  console.log(
    varied > 0
      ? '  The same input produced different work. This run is not a recording.'
      : '  Nothing differed on these runs. That is a report, not a failure — the coordination\n' +
        '  happened to resolve the same way each time. Run it again, or with more runs.',
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────

function requestedRuns(argv: readonly string[]): number {
  const at = argv.indexOf('--runs');
  if (at === -1) return 1;

  const value = Number(argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) {
    console.error('usage: npm run gate:workload -- --runs <positive integer>');
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const runs = requestedRuns(process.argv.slice(2));
  const embedder = new Embedder();
  const embed = (text: string) => embedder.embed(text);

  console.log(`the cut: ${DEMO_TASKS.map((task) => task.id).join(' ')}`);
  const waves = new Set(ASSIGNMENT.map((one) => one.wave)).size;
  console.log(`${ASSIGNMENT.length} assignments across 5 agents, in ${waves} waves`);
  console.log(
    `${runs} run(s), REPLAY — the agents apply reviewed patches, so no reasoning is billed;\n` +
      'the coordination, the races and the changefeed are live against the real cluster.',
  );

  const reports: RunReport[] = [];
  // Sequential, deliberately: two workloads at once would contend for the same Basic-tier burst
  // and every latency figure in the ledger would be measuring the other run.
  for (let index = 1; index <= runs; index += 1) {
    console.log(`\n\n══ RUN ${index} of ${runs} ══════════════════════════════════════════════════════════\n`);
    const report = await runOnce(index, runs === 1, embed);
    printReport(report);
    reports.push(report);
  }

  if (reports.length > 1) printLedger(reports);
  else {
    console.log(
      '\n  One run, so nothing was compared. `npm run gate:workload -- --runs 2` runs it again\n' +
        '  against fresh scopes and prints what differed — which is how this demonstrates that a\n' +
        '  run is not a recording, rather than asserting it.',
    );
  }

  const failures = reports.flatMap((report) => report.invariants.filter((one) => !one.ok));
  const notEvaluated = reports.flatMap((report) => report.notEvaluated);

  console.log('\n══ GATE ═══════════════════════════════════════════════════════════════════════');
  for (const report of reports) {
    const passed = report.invariants.filter((one) => one.ok).length;
    const seen = report.observations.filter((one) => one.seen).length;
    console.log(
      `  run${report.index}   INVARIANTS ${passed}/${report.invariants.length}` +
        `   OBSERVED ${seen}/${report.observations.length}`,
    );
  }
  if (notEvaluated.length > 0) {
    console.log(`  ${notEvaluated.length} invariant(s) could not be evaluated — see the runs above.`);
  }
  console.log(
    failures.length === 0
      ? '\nPASS — every invariant held on every run. Observations are reported, never enforced.'
      : `\nFAIL — ${failures.length} invariant failure(s): ${failures.map((one) => one.label).join('; ')}`,
  );
  console.log(`Bedrock embedding calls: ${embedder.stats.invocations}, cache hits: ${embedder.stats.hits}`);

  await closePool();
  if (failures.length > 0) process.exitCode = 1;
}

await main();
