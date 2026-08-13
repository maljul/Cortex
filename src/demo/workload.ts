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
 * the consolidation that arrives over the changefeed. Committed: the **patch bodies** and one
 * **closure note**. Julian's call on 2026-08-13; `07` §4 forbids implying a model wrote either,
 * so the page must say so. There is no model reasoning in this runner at all — see the note at
 * the foot of this file.
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
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, PatchError, type FileTree } from './patches.js';
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
  /** Live Titan calls. The only spend this runner can measure, and it is measured. */
  embeddingCalls: number;
  claimP50Ms: number | null;
  serializationRetries: number;
  /**
   * `06` §3's token metric. **TBD, not zero**: this runner makes no model call, so nobody has
   * measured it. `—` would claim the arm has no such thing to measure, and a bare 0 would claim
   * it measured nothing spent. U24 owns LIVE and therefore owns this number.
   */
  wastedTokens: null;
}

export interface ArmResult {
  arm: DemoArm;
  sessionId: string;
  /** What each agent reported per ticket — the input `src/demo/attribution.ts` requires. */
  steps: WorkStep[];
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
  const reportedDone: { taskId: string; files: string[]; informed: boolean }[] = [];

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
  async function applyAndSave(task: DemoTask, informed: boolean): Promise<string[] | null> {
    const patches = appliedPatches(task, informed);
    if (patches.length === 0) return [];

    // Read the tree, work, save — three round trips, and the middle one is not a database
    // operation. In the cortex lane a claim is held across all three; in the naive lane nothing
    // is, which is why its snapshot goes stale while it works.
    const before = await loadFiles(options.sessionId, scope);
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
    const applied = await applyAndSave(task, informed);
    // Unreachable in this lane — a second agent on the same file is deduped before it reads —
    // and asserted rather than assumed, because "cannot happen" in a comment is how it happens.
    if (applied === null) throw new Error(`${task.id}: arbitration let two agents patch one file`);
    const touched = applied;

    if (task.result === 'abandoned') {
      await close({
        repoId: options.sessionId,
        intentId: decision.intentId,
        result: 'abandoned',
        idempotencyKey: `wl-${task.id}-${decision.intentId}`,
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
      ...(task.closureNote ? { notes: task.closureNote } : {}),
      ...scope,
    });

    workDone.push({ key: task.id, statement: task.statement, embedding: embedded.embedding });
    reportedDone.push({ taskId: task.id, files: touched, informed });
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

    const applied = await applyAndSave(task, false);
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
    reportedDone.push({ taskId: task.id, files: touched, informed: false });
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

  // `lostWrites` is a subtraction over two counted quantities: hunks an agent was told it had
  // saved, and hunks that are in the tree now. Neither is predictable before the race resolves,
  // and neither is a literal — `test/workload.test.ts` fails if any meter figure becomes one.
  const acknowledgedHunks = reportedDone.flatMap((done) => appliedPatches(taskById(done.taskId), done.informed));
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

  return {
    arm: options.arm,
    sessionId: options.sessionId,
    steps,
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
      embeddingCalls: tally.calls,
      claimP50Ms: median(claimLatenciesMs(options.recorder?.statements ?? [])),
      serializationRetries: getRetryCount() - retriesBefore,
      wastedTokens: null,
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

/**
 * **No model call happens in this runner, and that is a deviation to publish rather than a
 * gap to paper over.**
 *
 * Design §3 says each agent's decision step is a model call whose prompt shape differs from the
 * benchmark's, and that the cassette library must be re-recorded for it. It is not built here.
 * What replaced it is stronger for the one decision that matters — which variant of a patch an
 * informed agent applies — because that choice is now driven by comparing recall's *returned
 * fact* against what consolidation actually wrote. No cached model output sits in the causal
 * path at all: if the changefeed has not delivered, the agent is uninformed, and the page says
 * so.
 *
 * The consequence for `07` §4's mode line is that it keeps its current honest wording — live
 * database, live embeddings, no model reasoning — rather than gaining "reasoning is cached".
 * Recorded in `docs/SPEC-DELTA.md`.
 */
export const RUNNER_MAKES_MODEL_CALLS = false;
