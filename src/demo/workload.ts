/**
 * THE WORKLOAD RUNNER — ten tickets, five agents, two arms, one cluster.
 *
 * `docs/superpowers/specs/2026-08-12-fleet-demo-design.md` §3–§5. This replaces the four
 * scripted beats of `src/demo/scenario.ts` with a real workload, and the beats stop being a
 * script: they are **observed moments**. Beat 1 happens when recall returns a finding; beat 2
 * when the cluster deduplicates a proposal; beat 3 when two agents want one file; beat 4 when a
 * closed intent comes back as a finding. If one does not happen, this runner reports that it did
 * not (design §9: "if a beat does not fire, the rail says so rather than faking it").
 *
 * ## What is live and what is committed
 *
 * Live, against the real cluster, in the visitor's own scope under `cortex_demo`'s row-level
 * security: every embedding, every dedupe search, every claim, every close, every recall, and
 * the consolidation that arrives over the changefeed.
 *
 * **Who writes the code is now a property of the run rather than of this file.** REPLAY — the
 * default, and what an anonymous visitor gets — applies the ticket's reviewed patches and one
 * **closure note**, and `07` §4 forbids implying a model wrote either, so the page must say so.
 * LIVE passes `modelAuthor` and the agents author their own edits. Which happened is measured:
 * `hunksAuthoredByModel`, `hunksFallenBack` and `hunksReplayed` partition every hunk applied.
 * See the note at the foot of this file.
 *
 * ## The two lanes
 *
 * | | naive | cortex |
 * | --- | --- | --- |
 * | dedupe search | same statement, own transaction | same transaction as the claim |
 * | claim | the **ticket** it picked up | the **files** the work touches |
 * | outcome memory | none — `06` §2's "Consolidation: none" | `findings`, via the changefeed |
 * | completion | a line in the shared task file | `close()`, ledger and all |
 * | working tree | same JSONB cell, same per-file save | same JSONB cell, same per-file save |
 *
 * Everything in the left column is a real thing people run — `01` §3's "a vector store plus a
 * lock service" — and `src/memory/naive-lane.ts` explains at length why none of it is a
 * strawman. Two consequences that took a decision each:
 *
 * - **The lock locks the ticket, not the file** (Julian, 2026-08-13). A job lock is what such a
 *   fleet actually takes, and it is exactly what cannot see two different tickets colliding in
 *   one file. Had it locked files and honoured them, the three contended agents would serialise
 *   and the interlock this demo is built on could not happen.
 * - **The naive lane closes its intents like anything else**, and the findings the changefeed
 *   then writes into its scope are never read by it, because a vector store plus a lock service
 *   has no step that consults an outcome. That is a sharper claim than withholding the tier, and
 *   it is the project's actual one: the rows sit in the same database, one query away, and the
 *   whole difference is whether arbitration and recall are in the agent's path. The first live
 *   run is why it closes at all — see the note on `naiveTicket`.
 *
 * ## Waves, and why there are three
 *
 * Two of design §3.1's interlocks turn on one agent's decision reaching another through recall,
 * and recall can only return what consolidation has written. So the run has an order:
 *
 *   1   I3 · P2a · P2b · P6a · P6b   the two dedupe pairs, racing, plus the decision R3 needs
 *   2   C1 · C2 · C3 · R3 · A1       the collision, the informed halves, the dead end
 *   3   T11                          the agent A1 spares
 *
 * **Each pair's halves race, and that is a correction the first live run forced** — see
 * `ASSIGNMENT`. Sequencing them let the *naive* lane deduplicate them too, because a
 * two-transaction dedupe against an intent that committed a second ago works perfectly well.
 *
 * **Wave 2 is a real race and nothing here may assume its winner.** C1, C2 and C3 propose
 * concurrently for one file; CockroachDB's unique index decides. The two that lose learn who
 * holds it (invariant 3) and come back on a later pass — which is `03` §5's "losing fast and
 * re-planning", not a queue: the loser's transaction ended, it holds nothing, and it returns
 * only after the holder has closed and released.
 *
 * ## Every meter figure is a count over what was recorded
 *
 * There is not one `meter.field += 1` in this file, deliberately. `07` §1 requires every number
 * on screen to come from the run, and U16b was caught with two that did not — `duplicateWorkDone`
 * and `lostWrites` were incremented unconditionally while the naive arm executed no statements at
 * all. The defence there was a source-text test forbidding an unguarded increment. The defence
 * here is that there is nothing to guard: each figure is a filter over `steps` and `events`,
 * a subtraction over a readback of the tree, or a distance the cluster computed. A fabricated
 * number would have to be a fabricated *event*, which the journey would show.
 */
import { claimLatenciesMs, type StatementRecorder } from '../db/recorder.js';
import { getRetryCount, isSerializationFailure } from '../db/retry.js';
import { withDegradedFallback, type MaybeDegraded } from '../embed/degraded.js';
import { close } from '../memory/close.js';
import { duplicatesAmong, type WorkDone } from '../memory/duplicates.js';
import { naiveClaim, naiveDedupeSearch } from '../memory/naive-lane.js';
import { DEFAULT_DEDUPE_THRESHOLD, propose } from '../memory/propose.js';
import { recall, type Finding } from '../memory/recall.js';
import { loadFiles, loadSharedState, saveFiles, saveSharedState } from '../memory/shared-state.js';
import { DEMO_TASKS, factOf, taskById, type DemoTask } from '../../bench/demo-workload.js';
import { APP_FILES } from './app-bundle.js';
import { committedAuthor, type PatchAuthor } from './author.js';
import { conflictingEdits, fileCollisions, spanOf, type WorkSpan } from './conflicts.js';
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, PatchError, type FileTree, type Patch } from './patches.js';
import type { WorkStep } from './attribution.js';

export type DemoArm = 'cortex' | 'naive';

/**
 * Which agent picks up which ticket, and in which wave. Five agents, two tickets each, and
 * agent-4 takes the eleventh.
 *
 * **Both halves of both dedupe pairs are in the same wave, and that is a correction with a
 * measurement behind it.** They were sequenced first, on U16b's precedent that "dedupe is a
 * temporal relationship" — and the first live run showed why that precedent does not transfer:
 * with the halves sequenced, the **naive lane deduplicated them too** (P6b at 0.0610, P2b at
 * 0.2058), because a two-transaction dedupe against an intent that committed a second ago works
 * perfectly well. Interlock 4 did not happen and duplicate work was 0 in both arms.
 *
 * U16b's naive arm had no dedupe at all, so sequencing cost it nothing. This one has a real one,
 * and design §4.2 is explicit about where it fails: "the dedupe passes against a snapshot that
 * was true a moment ago". That window only exists under concurrency. So the pairs race, and the
 * two lanes differ for the reason the design says they do.
 */
export const ASSIGNMENT: readonly { wave: number; taskId: string; agent: string }[] = [
  { wave: 1, taskId: 'I3', agent: 'agent-1' },
  { wave: 1, taskId: 'P2a', agent: 'agent-2' },
  { wave: 1, taskId: 'P2b', agent: 'agent-3' },
  { wave: 1, taskId: 'P6a', agent: 'agent-4' },
  { wave: 1, taskId: 'P6b', agent: 'agent-5' },
  { wave: 2, taskId: 'C1', agent: 'agent-1' },
  { wave: 2, taskId: 'C2', agent: 'agent-2' },
  { wave: 2, taskId: 'C3', agent: 'agent-3' },
  { wave: 2, taskId: 'R3', agent: 'agent-4' },
  { wave: 2, taskId: 'A1', agent: 'agent-5' },
  { wave: 3, taskId: 'T11', agent: 'agent-4' },
];

export const AGENTS: readonly string[] = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];

/** How long an agent waits for the fleet's memory to catch up before proceeding uninformed. */
const CONSOLIDATION_WAIT_MS = 4000;
const CONSOLIDATION_POLL_MS = 250;

/** How many passes the contended file gets before the runner gives up on draining it. */
const CONTENTION_PASSES = 4;

/**
 * One thing an agent did, as it happened. Design §5.3: fleet events are **not** rows and nothing
 * may imply they are — they carry no primary key, only the id of the statement that produced
 * them, and the page labels them differently from changefeed events.
 */
export interface FleetEvent {
  seq: number;
  arm: DemoArm;
  agent: string;
  taskId: string;
  phase:
    | 'started'
    | 'reading'
    | 'recalled'
    | 'decided'
    | 'claiming'
    | 'patched'
    | 'blocked'
    | 'deduped'
    | 'abandoned'
    | 'spared'
    | 'contended'
    | 'saved'
    | 'overwritten';
  /** Milliseconds since the run began. Real elapsed time, never a simulated clock. */
  at: number;
  detail?: Record<string, unknown>;
}

/**
 * One record per ticket that wrote anything: who authored the hunks and what it cost.
 *
 * A record rather than a counter. `src/demo/author.ts` decides whether an agent recites a
 * reviewed patch or writes the code itself, and every figure the page shows about that is a
 * filter or a sum over this list — so a fabricated authorship number would have to be a
 * fabricated *record*, which carries a task id and an agent the journey also names.
 */
export interface Authoring {
  taskId: string;
  agent: string;
  /** `model` — written and validated. `committed` — REPLAY, no call. `fallback` — called, refused. */
  source: 'model' | 'committed' | 'fallback';
  /** How many hunks this record covers, so the meter can speak in hunks rather than tickets. */
  hunks: number;
  inputTokens: number;
  outputTokens: number;
}

/** The authorship half of the meter, and `06` §3's token metric with it. */
export interface Authorship {
  hunksAuthoredByModel: number;
  hunksReplayed: number;
  hunksFallenBack: number;
  modelInputTokens: number | null;
  modelOutputTokens: number | null;
  wastedTokens: number | null;
}

/**
 * The authorship figures, derived from the records rather than accumulated alongside them.
 *
 * Exported and pure so that `test/workload.test.ts` can prove the two rules that matter without
 * a cluster run: the three hunk counts partition the work, and **an unmeasured token count is
 * `null` rather than `0`**. The second is `06` §6's line and it is the one most likely to be
 * crossed by accident: on REPLAY every record reports zero tokens, and summing zeroes produces a
 * `0` that renders exactly like a measurement of nothing spent.
 *
 * `wastedOn` is `06` §3's own set — the tickets whose intents ended `abandoned` or turned out to
 * duplicate work already underway. The caller supplies it because only the run knows which
 * those were.
 */
export function authorshipOf(
  authorings: readonly Authoring[],
  wastedOn: readonly string[],
): Authorship {
  const hunksFrom = (source: Authoring['source']): number =>
    authorings.filter((one) => one.source === source).reduce((total, one) => total + one.hunks, 0);

  // A call was made whenever the author was not the REPLAY one: `model` is a call that validated
  // and `fallback` is a call that did not, and both were billed. `committed` never reached
  // Bedrock, so it measured nothing — which is not the same as having measured nothing spent.
  const called = authorings.filter((one) => one.source !== 'committed');
  const spend = (records: readonly Authoring[]): number =>
    records.reduce((total, one) => total + one.inputTokens + one.outputTokens, 0);

  return {
    hunksAuthoredByModel: hunksFrom('model'),
    hunksReplayed: hunksFrom('committed'),
    hunksFallenBack: hunksFrom('fallback'),
    modelInputTokens: called.length === 0 ? null : called.reduce((t, one) => t + one.inputTokens, 0),
    modelOutputTokens: called.length === 0 ? null : called.reduce((t, one) => t + one.outputTokens, 0),
    wastedTokens:
      called.length === 0 ? null : spend(called.filter((one) => wastedOn.includes(one.taskId))),
  };
}

export interface ArmMeter {
  /** Proposals the cluster refused as duplicates before the agent spent anything. */
  duplicateWorkAvoided: number;
  /** Work done that duplicated work already underway — the same rule for both arms. */
  duplicateWorkDone: number;
  /** Hunks an agent reported done that are not in the final tree, by reading it back. */
  lostWrites: number;
  /** Agents that hit a held key, learned the holder, and came back. */
  blockedAndReplanned: number;
  /** Findings recall handed to an agent that then acted on them. */
  findingsRecalled: number;
  /** Agents spared entirely because the fleet already knew the answer. */
  agentsSpared: number;
  /**
   * Agents that took a ticket, worked it, and gave up — counting the second agent to walk into a
   * dead end the fleet had already found.
   *
   * This is interlock 5's cost and the only place it appears. There is no file difference between
   * the lanes there, so `src/demo/attribution.ts` correctly reports nothing, and the embedding
   * count does not show it either (it is dominated by contention retries). What separates the arms
   * is that one agent proposed, worked and abandoned where the other was told first: an abandoned
   * step **holding an intent** is a dead end walked, an abandoned step holding none is an agent
   * that stood down before spending anything.
   */
  deadEndsWalked: number;
  /**
   * `06` §3's metric, line-granular: hunk pairs by two different agents whose line ranges and
   * time windows both overlap, in one file. Counted the way `bench/metrics.ts` counts it, so the
   * demo's figure and the published benchmark's mean the same thing on the same page.
   */
  conflictingEdits: number;
  /**
   * Agent pairs that wrote one file in overlapping windows, whatever their lines — which is what
   * this lane's per-file write-back actually loses to, and what `conflictingEdits` misses.
   * Measured (V51): interlock 3's three agents edit disjoint regions of one file, so §3's rule
   * scores it 0 while the naive lane loses two of the three changes.
   */
  fileCollisions: number;
  /** Live Titan calls. The only spend this runner can measure, and it is measured. */
  embeddingCalls: number;
  claimP50Ms: number | null;
  serializationRetries: number;
  /**
   * `06` §3's token metric: tokens spent on intents ending `abandoned` or deduped-after-work,
   * summed from what the authors actually reported — the same rule `bench/metrics.ts` applies to
   * the benchmark, so the two figures on one page mean one thing.
   *
   * **`null`, not `0`, when no model was called.** `06` §6 draws the line: `—` claims the arm has
   * no such thing to measure and a bare `0` claims somebody measured nothing spent. A REPLAY run
   * reaches Bedrock for no reasoning at all, so nobody measured, so this is TBD and the page must
   * render it as TBD. It stops being null the moment a run has a model author.
   */
  wastedTokens: number | null;
  /**
   * WHO WROTE THE CODE, in hunks. Derived from `authorings` by `authorshipOf` — a filter and a
   * sum over records that exist because work happened, never a counter.
   *
   * `hunksAuthoredByModel` is what a model wrote and what validated; `hunksFallenBack` is what a
   * model wrote and what did not, so the agent applied the reviewed patch instead;
   * `hunksReplayed` is the REPLAY path, where no call was made. The three partition every hunk
   * any agent applied, which is what lets the page say "the model wrote 9 of 13 hunks on this
   * run" rather than asserting that it wrote them all.
   *
   * **Optional in the type and set on every path.** They are declared optional only so that an
   * `ArmResult` built by hand elsewhere in the suite does not have to be rewritten to name them;
   * `runArm` sets all five below on every return, and `test/workload.test.ts` reads this
   * declaration and fails if the returned meter literal omits a field it declares.
   */
  hunksAuthoredByModel?: number;
  hunksReplayed?: number;
  hunksFallenBack?: number;
  /** Bedrock's own `usage`, summed over every call this arm made. `null` when it made none. */
  modelInputTokens?: number | null;
  modelOutputTokens?: number | null;
}

export interface ArmResult {
  arm: DemoArm;
  sessionId: string;
  /** What each agent reported per ticket — the input `src/demo/attribution.ts` requires. */
  steps: WorkStep[];
  /**
   * Where every applied hunk landed and when its agent held it. The provenance for
   * `conflictingEdits` and `fileCollisions`, carried for the same reason `steps` is: a **0** that
   * cannot be told apart from "nothing was measured" is the failure `06` §6 draws its line
   * against, and these two figures are the ones most able to look measured while being empty.
   */
  spans: WorkSpan[];
  /**
   * Who wrote each ticket's hunks and what it cost — the provenance for the authorship figures,
   * carried for the same reason `spans` is. Optional in the type for the same reason those meter
   * fields are: a hand-built `ArmResult` elsewhere in the suite predates it. `runArm` always sets
   * it, and an empty list is a run in which nobody wrote anything, which the gate refuses.
   */
  authorings?: readonly Authoring[];
  events: FleetEvent[];
  /** The tree this lane finished with, read back from the cluster rather than accumulated. */
  tree: FileTree;
  /** Observed, never scripted. `false` means the moment did not happen on this run. */
  beats: { recall: boolean; dedupe: boolean; collision: boolean; consolidate: boolean };
  meter: ArmMeter;
}

export interface ArmOptions {
  sessionId: string;
  arm: DemoArm;
  embed: (text: string) => Promise<number[]>;
  recorder?: StatementRecorder;
  /** Called as each event happens, so U22 can stream instead of waiting for the return. */
  onEvent?: (event: FleetEvent) => void;
  /**
   * Who writes the code this arm's agents apply. Absent means REPLAY — the reviewed patches the
   * ticket already carries — which is what an anonymous visitor gets and why rule B4 stays
   * affordable for a month. LIVE supplies `modelAuthor`. Both arms in a run always get the *same*
   * author, or the comparison would be between two different systems rather than two coordination
   * strategies.
   */
  author?: PatchAuthor;
}

type Embedder = (text: string) => Promise<MaybeDegraded>;

function embedderFor(options: ArmOptions, tally: { degraded: number; calls: number }): Embedder {
  const fallback = withDegradedFallback(options.embed);
  return async (text: string) => {
    tally.calls += 1;
    const result = await fallback(text);
    if (result.degraded) tally.degraded += 1;
    return result;
  };
}

function scopeFor(options: ArmOptions) {
  return {
    plane: 'demo' as const,
    demoSession: options.sessionId,
    ...(options.recorder ? { recorder: options.recorder } : {}),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one arm of the workload to completion.
 *
 * Never throws for a contended, blocked, deduped or abandoned outcome — those are results. `04`
 * §5 invariant 1 admits no error page on any path a visitor can reach, and this is the path
 * behind the run button.
 */
export async function runArm(options: ArmOptions): Promise<ArmResult> {
  const started = Date.now();
  const retriesBefore = getRetryCount();
  const scope = scopeFor(options);
  const tally = { degraded: 0, calls: 0 };
  const embed = embedderFor(options, tally);

  const events: FleetEvent[] = [];
  const steps: WorkStep[] = [];
  const workDone: WorkDone[] = [];
  const intentIds = new Map<string, string>();
  /**
   * What each agent was told it had saved — and **which variant it applied**, because that is
   * what its hunks are.
   *
   * The `informed` flag is load-bearing rather than descriptive. Without it the readback below
   * looks for the *uninformed* replacement text, which an informed agent never wrote, and reports
   * every correctly-informed agent as having lost its write: the first gate run read
   * `writes lost 2` for the cortex lane, which had lost nothing. A number that is wrong in the
   * arm's own favour would be worse; this one was wrong against it, and it was still wrong.
   */
  /**
   * What each agent that reported `done` actually wrote.
   *
   * **`hunks` is the patches that were applied, not the ticket's committed ones**, and the
   * difference is the whole correctness of `lostWrites`. It read the committed text back until
   * 2026-08-17 — see the readback below for what that cost on a LIVE run.
   */
  const reportedDone: { taskId: string; files: string[]; informed: boolean; hunks: Patch[] }[] = [];

  /**
   * The hunks each agent actually applied, keyed by ticket and agent.
   *
   * Recorded by `applyAndSave` because that is the only place that knows: under REPLAY it is the
   * ticket's reviewed patch, and under LIVE it is whatever the model authored and validation
   * accepted. Every readback below reads this rather than re-deriving from the ticket.
   */
  const writtenByTicket = new Map<string, Patch[]>();
  const writtenKey = (taskId: string, agent: string): string => `${taskId}::${agent}`;

  /**
   * Where each applied hunk landed and when its ticket was open, for `06` §3's `conflicting_edits`
   * and for the file-level figure beside it. Recorded as the work happens because both are
   * questions about *overlap*, and a run that only kept its final tree could not answer either:
   * the tree is what survived, and a collision is two agents who both thought they had written it.
   */
  const spans: WorkSpan[] = [];

  /**
   * One record per ticket that wrote anything: who authored the hunks and what it cost.
   *
   * A list rather than a counter, deliberately. `test/workload.test.ts` forbids a meter figure
   * being incremented at all, because U16b shipped two that were incremented unconditionally and
   * rendered beside figures the driver had timed. Every figure derived from this is a filter or a
   * sum over records that exist because work happened, which is the same rule `06` §6 applies to
   * a count over an empty list.
   */
  const authorings: Authoring[] = [];

  /**
   * What this agent's work on this ticket cost, for `intents.tokens_spent`.
   *
   * `03` §4.3's column has existed since the beginning and `close()` has always written it; the
   * runner never had a number to give it, because nothing here spent a token. Now something can,
   * so the row carries what the run measured rather than the default. Summed over every record
   * for this agent and ticket, because a re-planned ticket authors twice and both attempts were
   * billed.
   */
  function tokensSpentOn(taskId: string, agent: string): number {
    return authorings
      .filter((one) => one.taskId === taskId && one.agent === agent)
      .reduce((total, one) => total + one.inputTokens + one.outputTokens, 0);
  }

  /**
   * REPLAY unless a caller supplies otherwise, and that default is what keeps rule B4 affordable:
   * an anonymous visitor's run reaches no model at all, while its coordination — dedupe, claims,
   * the race, the changefeed — is as live as it has ever been.
   */
  const author: PatchAuthor = options.author ?? committedAuthor();

  /**
   * What an agent may see, and therefore what it may edit.
   *
   * The union of the ticket's own patch targets across both variants — the files this ticket is
   * about. `validateEdits` refuses any file outside what it was handed, so this set is the whole
   * boundary between a model's output and the corpus, and it is derived from the ticket rather
   * than from a list someone maintains.
   */
  function visibleTo(task: DemoTask, tree: FileTree): FileTree {
    const wanted = new Set([
      ...task.patches.map((p) => p.file),
      ...(task.informedPatches ?? []).map((p) => p.file),
    ]);
    const visible: FileTree = {};
    for (const file of wanted) if (tree[file] !== undefined) visible[file] = tree[file]!;
    return visible;
  }

  /**
   * Observed, never scripted. `collision` is the one with two honest endings: a loser that
   * commits is told who holds the key (invariant 3), and a loser that conflicts is retried by
   * `withRetry` and may be granted after the holder released, with no block ever recorded.
   * Which happens is the cluster's to decide, so `blocked` is what sets this and the gate reports
   * the other route rather than counting it as an absence.
   */
  const beats = { recall: false, dedupe: false, collision: false, consolidate: false };

  function emit(
    agent: string,
    taskId: string,
    phase: FleetEvent['phase'],
    detail?: Record<string, unknown>,
  ): void {
    const event: FleetEvent = {
      seq: events.length + 1,
      arm: options.arm,
      agent,
      taskId,
      phase,
      at: Date.now() - started,
      ...(detail ? { detail } : {}),
    };
    events.push(event);
    options.onEvent?.(event);
  }

  // The repository both lanes start from, seeded once into the scope's own cell so that every
  // read and every save afterwards goes through the database rather than through this process.
  await saveFiles(options.sessionId, loadFixtureTree(APP_FILES, DEMO_APP_CORPUS), scope);

  /**
   * What the fleet already knows that bears on this ticket, and whether it arrived.
   *
   * Only the cortex lane has anywhere for an outcome to live, so the naive lane's agents recall
   * nothing — not as a handicap but because `06` §2 gives that arm no consolidation. When a
   * ticket declares that another ticket's finding would change how it works, this waits a bounded
   * while for consolidation to land, because the changefeed is asynchronous by design and an
   * agent that asked a moment too early would report "nothing known" about something the fleet
   * had just learned. Every wait is recorded; a timeout leaves the agent honestly uninformed.
   */
  async function whatIsKnown(
    task: DemoTask,
    agent: string,
    embedding: readonly number[],
  ): Promise<{ findings: Finding[]; informing: string | null; waitedMs: number }> {
    if (options.arm === 'naive') return { findings: [], informing: null, waitedMs: 0 };

    const wanted = task.informedBy ?? task.sparedBy;
    const wantedFact = wanted ? factOf(taskById(wanted)) : null;
    const deadline = Date.now() + (wantedFact ? CONSOLIDATION_WAIT_MS : 0);
    const startedWaiting = Date.now();

    for (;;) {
      const findings = await recall({
        repoId: options.sessionId,
        embedding,
        ...scope,
      });
      const informing = findings.find((f) => f.fact === wantedFact)?.fact ?? null;
      if (informing !== null || Date.now() >= deadline) {
        return { findings, informing, waitedMs: Date.now() - startedWaiting };
      }
      await sleep(CONSOLIDATION_POLL_MS);
    }
  }

  /**
   * Applies this ticket's patches to the tree as it stands, and saves only what it touched.
   *
   * Returns `null` when the anchor is gone — which is not a bug and must not throw. Two agents
   * doing the same work on the same file is the naive lane's whole failure mode, and when the
   * second one reads the tree *after* the first has saved, its patch has nothing to attach to.
   * The honest reading is that it did the work and discovered at write time that the work was
   * already done: everything spent, nothing delivered. `04` §5 invariant 1 admits no error page
   * on a path behind the run button, and this path is reachable on any run where the P2 pair's
   * halves finish far enough apart.
   *
   * The cortex lane cannot reach it: its second agent is deduped before it reads anything.
   */
  async function applyAndSave(
    task: DemoTask,
    agent: string,
    informed: boolean,
    findings: readonly Finding[],
  ): Promise<string[] | null> {
    // A ticket with nothing to write must not read the tree, and must not spend a model call to
    // discover that. The abandoned ticket is the case: it closes with a reason, not a patch.
    if (appliedPatches(task, informed).length === 0) return [];

    // Read the tree, work, save — three round trips, and the middle one is not a database
    // operation. In the cortex lane a claim is held across all three; in the naive lane nothing
    // is, which is why its snapshot goes stale while it works.
    const before = await loadFiles(options.sessionId, scope);
    /**
     * **The window a collision is measured against: read to save, and nothing wider.**
     *
     * This is where a stale snapshot forms and it is the only interval in which two agents can
     * both believe they are writing the current file. The first version of this measured from the
     * moment the agent picked the ticket up, and `npm run gate:workload` caught it the same hour:
     * the cortex lane reported **1** collision, which it cannot have — a cortex agent holds the
     * claim across all three steps, so the only thing overlapping was the time a *blocked* agent
     * spent waiting and retrying, holding nothing and having read nothing. A window that counts
     * waiting counts the mechanism working as though it had failed.
     */
    const readAt = Date.now() - started;

    /**
     * **The middle round trip is where an agent actually works, and since `src/demo/author.ts`
     * that can mean a model authoring the edit.**
     *
     * What it is handed is the tree *this agent just read* rather than a fresh read, so the text
     * it anchors against is byte-for-byte the text `applyPatch` will run against. A second read
     * could have moved underneath it, and an anchor that was true a moment ago is the exact
     * failure this demo exists to show — it must not also be a bug in this function.
     *
     * **The collision window now spans the thinking, and that is correct rather than convenient.**
     * `readAt` is still taken before the work, so an agent that reads, thinks for twenty seconds
     * and then writes is counted as holding a snapshot for the whole interval. It was. A cortex
     * agent holds its claim across all three steps, so nothing can land inside its window; a naive
     * agent holds a job lock that says nothing about files, so its window is exactly where a
     * stale write is born — and a slow model widens it, which is the mechanism showing more of
     * itself rather than less.
     */
    const authored = await author({
      taskId: task.id,
      statement: task.statement,
      agent,
      files: visibleTo(task, before),
      findings,
      committed: appliedPatches(task, informed),
    });
    authorings.push({
      taskId: task.id,
      agent,
      source: authored.source,
      hunks: authored.patches.length,
      inputTokens: authored.usage?.inputTokens ?? 0,
      outputTokens: authored.usage?.outputTokens ?? 0,
    });

    const patches = authored.patches;
    if (patches.length === 0) return [];
    writtenByTicket.set(writtenKey(task.id, agent), patches);

    let mine: FileTree = before;
    try {
      for (const patch of patches) mine = applyPatch(mine, patch);
    } catch (error) {
      if (!(error instanceof PatchError)) throw error;
      return null;
    }

    const touched = [...new Set(patches.map((p) => p.file))];
    const saved: FileTree = {};
    for (const file of touched) saved[file] = mine[file]!;
    await saveFiles(options.sessionId, saved, scope);

    // `06` §3's `conflicting_edits` needs where, not just what — and it is located against the
    // text **this agent read**, before its own patches moved anything. A range measured after the
    // edit would describe a file no other agent ever saw.
    //
    // **Recorded after the save, and the window ends there rather than at the patch.** The file is
    // not this agent's until the write lands, so an agent that read in between read a stale copy
    // and must count as overlapping. Ending the window at patch time under-counts by exactly the
    // duration of the write, which is the round trip where the loss actually happens.
    for (const patch of patches) {
      const located = spanOf(before[patch.file] ?? '', patch.find);
      if (!located) continue;
      spans.push({
        taskId: task.id,
        agent,
        file: patch.file,
        ...located,
        startedMs: readAt,
        endedMs: Date.now() - started,
      });
    }

    return touched;
  }

  /** One agent, one ticket, in the cortex lane. */
  async function cortexTicket(task: DemoTask, agent: string): Promise<'retry' | 'settled'> {
    emit(agent, task.id, 'started');

    const embedded = await embed(task.statement);
    const known = await whatIsKnown(task, agent, embedded.embedding);

    if (known.findings.length > 0) {
      beats.recall = true;
      emit(agent, task.id, 'recalled', {
        findings: known.findings.map((f) => ({
          fact: f.fact,
          confidence: f.confidence,
          distance: Number(f.distance.toFixed(4)),
          timesReverted: f.timesReverted,
        })),
        informing: known.informing,
        waitedMs: known.waitedMs,
      });
    }

    // The spared agent. It has not been *stopped* — dedupe cannot see an abandoned intent and
    // deliberately never will — it has been *told*, and it decided. That distinction is the
    // whole of interlock 5.
    if (task.sparedBy && known.informing !== null) {
      steps.push({ taskId: task.id, agent, intentId: null, reported: 'abandoned' });
      emit(agent, task.id, 'spared', {
        by: task.sparedBy,
        fact: known.informing,
        note: 'the fleet had already found this out, so no budget was spent finding it again',
      });
      return 'settled';
    }

    emit(agent, task.id, 'claiming', { keys: task.resourceKeys });

    const decision = await propose({
      repoId: options.sessionId,
      agentId: agent,
      statement: task.statement,
      resourceKeys: task.resourceKeys,
      embedding: embedded.embedding,
      degradedEmbedding: embedded.degraded,
      ...scope,
    });

    if (decision.decision === 'deduped') {
      beats.dedupe = true;
      steps.push({ taskId: task.id, agent, intentId: null, reported: 'deduped' });
      // Invariant 4: a deduped agent receives the prior outcome, not a rejection.
      emit(agent, task.id, 'deduped', {
        of: decision.of,
        holder: decision.holder,
        priorOutcome: decision.outcome,
        distance: Number(decision.distance.toFixed(4)),
        threshold: DEFAULT_DEDUPE_THRESHOLD,
      });
      return 'settled';
    }

    if (decision.decision === 'blocked') {
      beats.collision = true;
      // Invariant 3: it learns the holder and the holder's intent, so it can re-plan rather
      // than poll. It holds nothing and its transaction has ended.
      emit(agent, task.id, 'blocked', {
        contested: decision.contested,
        note: 'it holds nothing and will come back once the holder closes',
      });
      return 'retry';
    }

    intentIds.set(task.id, decision.intentId);
    emit(agent, task.id, 'reading', { files: [...new Set(task.patches.map((p) => p.file))] });

    const informed = known.informing !== null && task.informedPatches !== undefined;
    const applied = await applyAndSave(task, agent, informed, known.findings);
    if (applied === null) {
      /**
       * **"Cannot happen" in a comment is how it happens, and this is the second time.**
       *
       * This was an unconditional throw, on the reasoning that a second cortex agent on the same
       * file is deduped before it ever reads. That is true — while dedupe runs. `04` §5 rung 2
       * turns every embedding into a hash vector and **skips dedupe entirely** rather than run it
       * at a meaningless threshold, and the moment it does, the second half of a dedupe pair
       * proceeds exactly as the naive lane's does: it reads, it works, and its anchor is gone by
       * the time it writes.
       *
       * `npm run gate:ladder` caught it — the rung §5 singles out as the one most likely to fire
       * unnoticed produced a *throw* behind the run button, which is `04` §5 invariant 1's own
       * failure. The assertion was right about arbitration and wrong about what else could put a
       * null here.
       *
       * So the invariant is kept where it still holds and dropped where it never did: with a real
       * embedding this is still an arbitration failure and still throws. With a degraded one it is
       * the documented cost of the rung, reported the way the naive lane reports the same event.
       */
      if (!embedded.degraded) {
        throw new Error(`${task.id}: arbitration let two agents patch one file`);
      }

      // It did the work and none of it landed, which is what skipping dedupe buys. Counted as
      // work done in this lane too, because it was — `duplicateWorkDone` is a measurement of the
      // run, not a property of the arm.
      workDone.push({ key: task.id, statement: task.statement, embedding: embedded.embedding });
      steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'contended' });
      await close({
        repoId: options.sessionId,
        intentId: decision.intentId,
        result: 'done',
        idempotencyKey: `wl-${task.id}-${decision.intentId}`,
        tokensSpent: tokensSpentOn(task.id, agent),
        ...scope,
      });
      emit(agent, task.id, 'contended', {
        intentId: decision.intentId,
        note:
          'dedupe was skipped because this intent could not be embedded (04 §5 rung 2), so this ' +
          'agent repeated work another had already done; nothing of its own landed',
      });
      return 'settled';
    }
    const touched = applied;

    if (task.result === 'abandoned') {
      await close({
        repoId: options.sessionId,
        intentId: decision.intentId,
        result: 'abandoned',
        idempotencyKey: `wl-${task.id}-${decision.intentId}`,
        tokensSpent: tokensSpentOn(task.id, agent),
        ...(task.closureNote ? { notes: task.closureNote } : {}),
        ...scope,
      });
      steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'abandoned' });
      emit(agent, task.id, 'abandoned', {
        intentId: decision.intentId,
        reason: task.closureNote,
        note: 'written down where the next agent will find it, which is V39',
      });
      return 'settled';
    }

    await close({
      repoId: options.sessionId,
      intentId: decision.intentId,
      result: 'done',
      idempotencyKey: `wl-${task.id}-${decision.intentId}`,
      filesChanged: touched,
      tokensSpent: tokensSpentOn(task.id, agent),
      ...(task.closureNote ? { notes: task.closureNote } : {}),
      ...scope,
    });

    workDone.push({ key: task.id, statement: task.statement, embedding: embedded.embedding });
    reportedDone.push({
      taskId: task.id,
      files: touched,
      informed,
      hunks: writtenByTicket.get(writtenKey(task.id, agent)) ?? [],
    });
    steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'done' });
    emit(agent, task.id, 'patched', {
      intentId: decision.intentId,
      files: touched,
      informed,
      awaiting: 'consolidation, arriving over the change stream',
    });
    return 'settled';
  }

  /** One agent, one ticket, in the naive lane — a vector store, then a lock, then work. */
  async function naiveTicket(task: DemoTask, agent: string): Promise<'retry' | 'settled'> {
    emit(agent, task.id, 'started');

    const embedded = await embed(task.statement);
    const input = {
      repoId: options.sessionId,
      agentId: agent,
      statement: task.statement,
      // The ticket, not the files. See `src/memory/naive-lane.ts`.
      lockKeys: [`task:${task.id}`],
      resourceKeys: task.resourceKeys,
      embedding: embedded.embedding,
      ...scope,
    };

    // TRANSACTION ONE. It commits, and then the agent works.
    const duplicate = await naiveDedupeSearch(input);
    if (duplicate) {
      beats.dedupe = true;
      steps.push({ taskId: task.id, agent, intentId: null, reported: 'deduped' });
      emit(agent, task.id, 'deduped', {
        of: duplicate.of,
        holder: duplicate.holder,
        distance: Number(duplicate.distance.toFixed(4)),
        threshold: DEFAULT_DEDUPE_THRESHOLD,
      });
      return 'settled';
    }
    emit(agent, task.id, 'decided', {
      note: 'the vector store had nothing near this a moment ago',
    });

    // TRANSACTION TWO. Whatever happened in between is not in the snapshot above.
    const decision = await naiveClaim(input);
    if (decision.decision === 'blocked') {
      emit(agent, task.id, 'blocked', { contested: decision.contested });
      return 'retry';
    }

    intentIds.set(task.id, decision.intentId);
    emit(agent, task.id, 'reading', { files: [...new Set(task.patches.map((p) => p.file))] });

    // Empty findings, and not because this lane is handicapped: `whatIsKnown` returns nothing for
    // it because that stack has no verb with which to ask. Same model, same statement, same files,
    // same ceiling — the only missing thing is what the fleet already paid to learn.
    const applied = await applyAndSave(task, agent, false, []);
    if (applied === null) {
      // It read, it worked, and by the time it wrote, the change was already there. Its budget is
      // spent and it delivered nothing — the sharpest form of the duplicate work this lane does,
      // and it counts as work done because it was.
      workDone.push({ key: task.id, statement: task.statement, embedding: embedded.embedding });
      steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'contended' });
      await close({
        repoId: options.sessionId,
        intentId: decision.intentId,
        result: 'done',
        idempotencyKey: `wl-${task.id}-${decision.intentId}`,
        // Everything it spent, and nothing of it landed. That is the sharpest wasted token in
        // the run and the row has to carry it or `06` §3's metric cannot see it.
        tokensSpent: tokensSpentOn(task.id, agent),
        ...scope,
      });
      emit(agent, task.id, 'contended', {
        intentId: decision.intentId,
        note: 'another agent had already made this exact change while this one was working; nothing of its own landed',
      });
      return 'settled';
    }
    const touched = applied;

    /**
     * The naive agent finishes its ticket: it writes what it did into the shared task file, and
     * it closes the intent so the lease is released and the row leaves the dedupe candidate set.
     *
     * **The close is deliberate and the first live run is why.** Not closing left A1's intent
     * `in_flight` for ever, and `findDuplicate`'s candidate set is `status IN ('in_flight',
     * 'done')` — so the naive lane deduplicated the eleventh ticket against a task that had been
     * *given up on*, at 0.3686. Its agent stood down believing somebody was working on it.
     * That is a subtler defect than the one interlock 5 is about and it deleted the visible one,
     * so the lane closes its intents like anything else. V38 relied on exactly this exclusion
     * when it cleared T11 for dedupe safety.
     *
     * **What follows, and it must be said on the page rather than hidden.** The changefeed sink
     * consolidates any closed intent in any live demo scope, so findings rows do appear in this
     * lane's scope. Nothing in this lane ever reads them: there is no recall step in a vector
     * store plus a lock service. That is not a weaker claim than withholding the tier — it is
     * the project's actual claim, sharper. The rows are in the same database, one query away, and
     * the difference in outcome is entirely whether arbitration and recall are in the agent's
     * path. Recorded in `docs/DECISIONS.md`; the panel consequence is U25's.
     *
     * **No notes**, because this lane has no notion of writing an outcome down *for another
     * agent* — what it knows goes in its own task-file entry, where the fleet cannot reach it.
     */
    const state = await loadSharedState(options.sessionId, scope);
    state.completed[`${agent}:${task.id}`] = {
      agent,
      statement: task.statement,
      resourceKeys: [...task.resourceKeys],
      note:
        task.result === 'abandoned'
          ? `gave up: ${task.closureNote ?? 'no reason recorded'}`
          : `edited ${touched.join(', ')}`,
    };
    await saveSharedState(options.sessionId, state, scope);

    await close({
      repoId: options.sessionId,
      intentId: decision.intentId,
      result: task.result,
      idempotencyKey: `wl-${task.id}-${decision.intentId}`,
      tokensSpent: tokensSpentOn(task.id, agent),
      ...(touched.length > 0 ? { filesChanged: touched } : {}),
      ...scope,
    });

    if (task.result === 'abandoned') {
      steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'abandoned' });
      emit(agent, task.id, 'abandoned', {
        intentId: decision.intentId,
        reason: task.closureNote,
        note: 'it found this out and wrote it in its own task file, where no other agent looks',
      });
      return 'settled';
    }

    workDone.push({ key: task.id, statement: task.statement, embedding: embedded.embedding });
    // `informed: false` always in this lane, and not as a default: it has no findings tier, so
    // there is nothing that could have informed it. See `whatIsKnown`.
    reportedDone.push({
      taskId: task.id,
      files: touched,
      informed: false,
      hunks: writtenByTicket.get(writtenKey(task.id, agent)) ?? [],
    });
    steps.push({ taskId: task.id, agent, intentId: decision.intentId, reported: 'done' });
    emit(agent, task.id, 'patched', { intentId: decision.intentId, files: touched });
    return 'settled';
  }

  const runTicket = options.arm === 'cortex' ? cortexTicket : naiveTicket;

  /**
   * Runs a ticket and lets it re-plan once if the cluster refused it five times running.
   *
   * `03` §5's own instruction rather than a workaround for it: the retry helper is capped at
   * five deliberately, and §5's next sentence says an agent that has lost fast re-plans. A
   * second exhaustion is reported as `contended` — never as an exception, because `04` §5
   * invariant 1 admits no error page behind the run button.
   */
  async function withReplan(task: DemoTask, agent: string): Promise<'retry' | 'settled'> {
    try {
      return await runTicket(task, agent);
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }
    try {
      return await runTicket(task, agent);
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
      steps.push({ taskId: task.id, agent, intentId: null, reported: 'contended' });
      emit(agent, task.id, 'contended', {
        note: 'two rounds of five SERIALIZABLE attempts and it still could not commit. It holds nothing — no work was done twice and none was lost',
      });
      return 'settled';
    }
  }

  const waves = [...new Set(ASSIGNMENT.map((a) => a.wave))].sort((a, b) => a - b);
  for (const wave of waves) {
    let outstanding = ASSIGNMENT.filter((a) => a.wave === wave);

    // Each pass runs what is left concurrently. A pass that grants nobody new is the end of it:
    // the loop drains contention rather than waiting on it, and it cannot spin.
    for (let pass = 0; pass < CONTENTION_PASSES && outstanding.length > 0; pass += 1) {
      const results = await Promise.all(
        outstanding.map((assignment) =>
          withReplan(taskById(assignment.taskId), assignment.agent).then((outcome) => ({
            assignment,
            outcome,
          })),
        ),
      );

      const retrying = results.filter((r) => r.outcome === 'retry').map((r) => r.assignment);
      if (retrying.length === outstanding.length && pass > 0) break;
      outstanding = retrying;
    }

    for (const assignment of outstanding) {
      // Reported as contended, not as an error: it never got the key and it holds nothing.
      steps.push({
        taskId: assignment.taskId,
        agent: assignment.agent,
        intentId: null,
        reported: 'contended',
      });
      emit(assignment.agent, assignment.taskId, 'contended', {
        note: `the key was still held after ${CONTENTION_PASSES} passes`,
      });
    }
  }

  // ---- The readback, and the meters derived from it --------------------------------
  const tree = await loadFiles(options.sessionId, scope);

  /**
   * `lostWrites` is a subtraction over two counted quantities: hunks an agent was told it had
   * saved, and hunks that are in the tree now. Neither is predictable before the race resolves,
   * and neither is a literal — `test/workload.test.ts` fails if any meter figure becomes one.
   *
   * **It read back the ticket's *committed* text until 2026-08-17, and on a LIVE run that made
   * this figure a lie in the worst possible direction.** `appliedPatches(taskById(...))` returns
   * the reviewed patch; a model authors different text; so every model-authored hunk failed
   * `tree[file].includes(patch.replace)` and was counted as lost. The arm that used the model
   * *more* accrued more phantom losses, and the first real LIVE run on the deployed page reported
   * **CORTEX 8 lost writes against the naive lane's 6** — the headline claim, inverted, by a
   * measurement bug.
   *
   * It is the same text-matching mistake `src/demo/attribution.ts` and `scripts/gate-workload.mts`
   * were moved off, still living in the meter, and it survived because REPLAY makes the two
   * quantities identical: under the default path the committed text *is* what was written, so the
   * bug is invisible in every test and every gate run that does not call a model.
   *
   * So the readback compares against what each agent **actually wrote** — recorded by
   * `applyAndSave`, the only place that knows.
   */
  const acknowledgedHunks = reportedDone.flatMap((done) => done.hunks);
  const survivingHunks = acknowledgedHunks.filter((patch) =>
    tree[patch.file]?.includes(patch.replace),
  );

  const duplicates = await duplicatesAmong(workDone, {
    threshold: DEFAULT_DEDUPE_THRESHOLD,
    ...scope,
  });

  // Beat 4 is the changefeed's, not this runner's: it reports that closures happened and that
  // recall later saw one of them come back. `consolidate` is true only if a finding this run
  // produced was actually returned by a live recall — see `whatIsKnown`.
  beats.consolidate =
    options.arm === 'cortex' && events.some((e) => e.detail?.['informing'] != null);

  /**
   * `06` §3's own set: the tickets whose tokens were wasted — an intent that ended `abandoned`
   * after its agent had worked, and work that turned out to duplicate work already underway.
   * Dedupe *before* the work spends nothing and is deliberately not in it, exactly as
   * `bench/metrics.ts` has it.
   */
  const wastedOn = [
    ...duplicates.map((duplicate) => duplicate.key),
    ...steps
      .filter((step) => step.reported === 'abandoned' && step.intentId !== null)
      .map((step) => step.taskId),
  ];
  const authorship = authorshipOf(authorings, wastedOn);

  return {
    arm: options.arm,
    sessionId: options.sessionId,
    steps,
    spans,
    authorings,
    events,
    tree,
    beats,
    // Every figure below is a count over what was recorded, a subtraction over a readback, or a
    // distance the cluster computed. See this file's header for why there is no increment.
    meter: {
      duplicateWorkAvoided: steps.filter((step) => step.reported === 'deduped').length,
      duplicateWorkDone: duplicates.length,
      lostWrites: acknowledgedHunks.length - survivingHunks.length,
      blockedAndReplanned: events.filter((event) => event.phase === 'blocked').length,
      findingsRecalled: events
        .filter((event) => event.phase === 'recalled')
        .reduce((total, event) => total + (event.detail?.['findings'] as unknown[]).length, 0),
      agentsSpared: events.filter((event) => event.phase === 'spared').length,
      deadEndsWalked: steps.filter(
        (step) => step.reported === 'abandoned' && step.intentId !== null,
      ).length,
      conflictingEdits: conflictingEdits(spans),
      fileCollisions: fileCollisions(spans),
      embeddingCalls: tally.calls,
      claimP50Ms: median(claimLatenciesMs(options.recorder?.statements ?? [])),
      serializationRetries: getRetryCount() - retriesBefore,
      wastedTokens: authorship.wastedTokens,
      hunksAuthoredByModel: authorship.hunksAuthoredByModel,
      hunksReplayed: authorship.hunksReplayed,
      hunksFallenBack: authorship.hunksFallenBack,
      modelInputTokens: authorship.modelInputTokens,
      modelOutputTokens: authorship.modelOutputTokens,
    },
  };
}

/**
 * The hunks a ticket produces, in the variant its agent actually applied.
 *
 * One function rather than the expression written twice, because the two places that need it are
 * "what to write" and "what to look for afterwards" — and the whole point of the readback is that
 * it asks about the same thing the agent wrote. Two copies of the choice is one edit away from a
 * meter that measures a hunk nobody produced.
 */
export function appliedPatches(task: DemoTask, informed: boolean) {
  return informed && task.informedPatches ? task.informedPatches : task.patches;
}

/** Median, on the small samples a single run produces. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/** Every ticket the run performs, in wave order. Ten from the benchmark plus the eleventh. */
export const WORKLOAD_TASKS: readonly DemoTask[] = DEMO_TASKS;

/*
 * **HOW MANY MODEL CALLS THIS RUNNER MAKES IS A PROPERTY OF THE RUN, NOT OF THE FILE.**
 *
 * This used to be `RUNNER_MAKES_MODEL_CALLS = false`, and it was true: the content of every hunk
 * was committed text and only the coordination was live. `src/demo/author.ts` made it a question
 * with two answers — REPLAY reaches Bedrock for no reasoning at all, LIVE has the model author
 * every hunk — so a constant can no longer answer it and one that tried would be wrong on half
 * the runs. A boolean that is wrong half the time is worse than no boolean, and this repository
 * has paid for that shape before.
 *
 * The answer for a given run is measured and on the meter: `hunksAuthoredByModel`,
 * `hunksFallenBack` and `hunksReplayed` partition every hunk any agent applied, and
 * `modelInputTokens` / `modelOutputTokens` are `null` rather than `0` when nothing was called.
 * `07` §4's mode line therefore reads off the run instead of off this file.
 *
 * What has not changed, and is the reason REPLAY is still a real demonstration: the decision an
 * informed agent makes is driven by comparing recall's *returned fact* against what
 * consolidation actually wrote. No cached model output sits in that causal path in either mode —
 * if the changefeed has not delivered, the agent is uninformed, and the page says so.
 */
