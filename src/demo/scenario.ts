/**
 * THE FOUR BEATS — spec/07-DEMO-AND-SUBMISSION.md §3, driven against the real cluster.
 * spec/05-INTERFACES.md §5's `POST /demo/run`.
 *
 * `07` §3 orders the beats to satisfy the memory-first narrative, and each one has to
 * *happen* rather than be depicted: rule A7 requires the project to function as shown, so
 * every decision below is the return value of `src/memory/`'s own functions, taken in a
 * live demo session scope under `cortex_demo`'s row-level security.
 *
 * | Beat | What the judge sees | Where it comes from |
 * | 1 Recall | a finding from "a session 14 days ago", with a prior revert | `recall()` |
 * | 2 Dedupe | a differently-worded intent deduped before spending a token | `propose()` |
 * | 3 Claim | two agents, one file, one winner, the loser learns who | `propose()` |
 * | 4 Consolidate | the closed intent becoming a finding over the stream | the changefeed |
 *
 * **The NAIVE arm is the demo's spine and it is not a mock.** `07` §2: "Same scenario,
 * same cassettes, visibly different outcome. Contrast persuades; description does not."
 * NAIVE runs the identical statements against the identical embeddings and simply has no
 * shared memory to arbitrate against — so it recalls nothing, does the duplicate work, and
 * loses a write to last-write-wins. **It performs that work against the database**, through
 * `src/memory/shared-state.ts`, and its losses are then *measured by reading the row back*.
 * Until 2026-08-12 they were not: `meter.duplicateWorkDone += 1` and `meter.lostWrites += 1`
 * were unconditional, the naive arm executed no statements at all, and two fabricated
 * constants were rendered in the same table and the same style as figures the driver had
 * timed. `07` §1 requires every number on screen to be real and to come from the database;
 * `test/scenario.test.ts` now fails if a meter field is written from a literal.
 *
 * **What is a race here and what is a sequence, stated plainly because the difference is
 * the demo's honesty.**
 *
 * - Beat 3 is a **real race**. Both agents propose concurrently, on their own pooled
 *   connections, and the winner is decided by CockroachDB's unique index on
 *   `(repo_id, resource_key)` — not by which line of this file runs first. Run it twice and
 *   the winner changes, which is the evidence standard U6's contention gate set. Nothing
 *   below assumes which one wins.
 * - Beat 2 is a **sequence**, and deliberately. Dedupe is a *temporal* relationship: a
 *   later agent discovers that its task is already in flight. Two agents proposing in the
 *   same instant on the same key is not a dedupe at all — arbitration correctly grants one
 *   and blocks the other, which is beat 3. Racing beat 2 would not make it more honest, it
 *   would delete it. Reasoning in `docs/DECISIONS.md`.
 * - The NAIVE agents all run **concurrently**, because overlap is the entire mechanism
 *   there and nothing arbitrates between them.
 *
 * **Beat 1 needs a past, and the past is seeded explicitly.** A session that is seconds
 * old cannot have a memory from fourteen days ago, so the run writes one: a finding, and a
 * reverted intent that finding points at. It is seeded *through the same tables* the rest
 * of the demo reads, in the visitor's own scope, and the SQL for it appears in the show-SQL
 * panel like everything else. What must never happen is the panel implying the fleet
 * discovered something it was handed — so the response labels the seed as a seed.
 */
import { claimLatenciesMs, type StatementRecorder } from '../db/recorder.js';
import { getRetryCount, isSerializationFailure } from '../db/retry.js';
import { close } from '../memory/close.js';
import { consolidate } from '../memory/consolidate.js';
import { survivingWork } from '../memory/demo.js';
import { duplicatesAmong, type DuplicatedWork, type WorkDone } from '../memory/duplicates.js';
import { DEFAULT_DEDUPE_THRESHOLD, propose, type ProposeResult } from '../memory/propose.js';
import { recall } from '../memory/recall.js';
import { loadSharedState, saveSharedState } from '../memory/shared-state.js';

export type DemoArm = 'cortex' | 'naive';

/** Fourteen days, from `07` §3 beat 1's "a session 14 days ago". */
const SEED_AGE_DAYS = 14;

/**
 * The cast and the script. Fixed strings, because the beats have to read the same way
 * every time a judge runs them — and because beat 2 turns on two statements meaning the
 * same thing in different words, which is a property of these exact sentences.
 */
export const SCRIPT = {
  /**
   * Measured, not chosen by ear. Under real Titan embeddings (V28):
   *
   *   seedStatement / dedupeHolder   0.7660   — far outside dedupe's 0.39, on purpose
   *   dedupeHolder  / dedupeCaller   0.1680   — well inside it, so beat 2 fires
   *   contenderA    / contenderB     0.6995   — two different tasks, one shared file
   *   seedFact      / dedupeHolder   0.3801   — beat 1's recall, and see the note below
   *
   * The first line is a bug this script had and no test could have caught. The seed's
   * original statement was "make the orders client retry 429s", which sits **0.2969** from
   * agent-2's — inside the dedupe threshold — so agent-2 was deduped against the demo's own
   * seed, and beat 4 never happened because there was no granted intent to close. Test
   * vectors could not have found it: the tests control distances exactly, and this is a
   * fact about what Titan does to these particular English sentences. U11 learned the same
   * lesson from the other direction.
   *
   * **Any statement added or reworded here must be measured against the others under
   * Titan before it ships, and the measured distance belongs in this comment.**
   *
   * **Beat 1 fires as of 2026-08-12, and nothing in this file was changed to make it.**
   * `recall` filtered at `dist < 0.35` (`03` §4.1's published SQL) while the closest honest
   * wording of this finding is 0.3801, so the beat reported "nothing known" truthfully for
   * two days. What changed is the mechanism constant: `DEFAULT_MAX_DISTANCE` is now 0.60,
   * chosen by Julian from `bench/results/2026-08-12T18-35-38-014Z/recall-threshold-sweep.md`
   * as the largest value on that corpus returning nothing irrelevant (V33/V34).
   *
   * The distinction worth preserving: the constant was **not** moved to the smallest value
   * that rescues this beat. That would have been 0.39, and choosing it would have been `06`
   * §3's circularity — the demo tuning the mechanism it exists to showcase. The criterion
   * used is a property of the sweep's corpus and selects 0.60 with no demo in existence.
   * If the sweep is ever re-run against harder negatives and the constant comes back down
   * below 0.3801, this beat goes quiet again, and that is the correct outcome rather than a
   * regression to paper over.
   */
  seedFact: 'adding a retry to the orders client broke 429 handling and was reverted',
  seedStatement: 'switch the orders queue driver to SQS',

  /** Beat 2. The second is a paraphrase of the first and shares almost no vocabulary. */
  dedupeHolder: { agent: 'agent-2', statement: 'add a retry to the orders client' },
  dedupeCaller: { agent: 'agent-4', statement: 'make the orders client retry failed requests' },
  dedupeKeys: ['file:src/orders/client.ts'],

  /**
   * Beat 3. Two different tasks that need the same file — the contention `03` §3 is about.
   *
   * **A and B, not winner and loser.** They were named `claimWinner` and `claimLoser` while
   * they were called in sequence and agent-3 therefore always won. They race now, so those
   * names would be a prediction the code is not entitled to make, and a name that turns out
   * false on half the runs is worse than a dull one.
   */
  contenderA: { agent: 'agent-3', statement: 'add an index to the orders table' },
  contenderB: { agent: 'agent-5', statement: 'rename the orders status column' },
  claimKeys: ['file:src/orders/schema.sql'],
} as const;

export interface BeatStep {
  beat: 1 | 2 | 3 | 4;
  /** `seed` marks work the run performed to give beat 1 a past. Never presented as memory. */
  kind: 'seed' | 'recall' | 'propose' | 'close' | 'consolidate';
  agent: string;
  statement: string;
  decision: string;
  detail: Record<string, unknown>;
}

export interface RunResult {
  arm: DemoArm;
  sessionId: string;
  steps: BeatStep[];
  meter: {
    duplicateWorkAvoided: number;
    /**
     * Work that was done despite duplicating work already underway, measured by
     * `duplicatesAmong` — the *same* rule and the same threshold `propose()` arbitrates on,
     * with the distances computed by CockroachDB's own `<=>`. Both arms are measured; they
     * differ because CORTEX's duplicate agent was deduped and so never did the work, and
     * NAIVE's had nothing to stop it.
     */
    duplicateWorkDone: number;
    /**
     * Work that was acknowledged and is no longer there, measured by reading back what
     * survived. NAIVE loses to last-write-wins on the shared cell; CORTEX is asked the same
     * question of its own intents and answers 0 because each agent held a claim nobody else
     * could take. Never a written constant — see `test/scenario.test.ts`.
     */
    lostWrites: number;
    blockedAndReplanned: number;
    findingsRecalled: number;
    /**
     * `04` §7 requires the UI to display claim p50 and the retry counter live. Both are
     * measured from this run rather than estimated:
     *
     * - `claimP50Ms` is the median of the claim acquisitions the `StatementRecorder` timed
     *   — see `claimLatenciesMs`, which owns recognising them because naming SQL belongs
     *   in `src/db/`. Null when nothing was claimed, which is every NAIVE run: a NAIVE
     *   fleet acquires no claims, and a zero there would read as "very fast" rather than
     *   "never happened".
     * - `serializationRetries` is a delta around this run, not the process total: the
     *   Lambda's counter is module-scope and survives between invocations, so a raw read
     *   would show a visitor the retries of everyone before them. **It can now be
     *   non-zero**: beat 3's two agents genuinely contend, and U12 recorded that the
     *   benchmark's serialised scheduler makes the same metric 0 by construction.
     */
    claimP50Ms: number | null;
    serializationRetries: number;
  };
}

export interface RunOptions {
  sessionId: string;
  arm: DemoArm;
  embed: (text: string) => Promise<number[]>;
  recorder?: StatementRecorder;
}

type Actor = { agent: string; statement: string };

/** Every call in this file writes as `cortex_demo`, scoped to the visitor's session. */
function planeFor(options: RunOptions): {
  plane: 'demo';
  demoSession: string;
  recorder?: StatementRecorder;
} {
  return {
    plane: 'demo',
    demoSession: options.sessionId,
    ...(options.recorder ? { recorder: options.recorder } : {}),
  };
}

/**
 * Gives the session a past: one finding, and the reverted intent it came from.
 *
 * The revert is the load-bearing half. `recall` orders findings by `times_reverted` ahead
 * of distance, so beat 1's "with a note that a prior attempt was reverted" is not a caption
 * — it is the ordering the query returns, and it reaches it through this intent.
 */
async function seedPast(options: RunOptions): Promise<BeatStep[]> {
  const embedding = await options.embed(SCRIPT.seedFact);
  const scope = planeFor(options);

  const intentId = await propose({
    repoId: options.sessionId,
    agentId: 'agent-0',
    statement: SCRIPT.seedStatement,
    resourceKeys: ['file:src/orders/queue.ts'],
    embedding: await options.embed(SCRIPT.seedStatement),
    ...scope,
  }).then((decision) => (decision.decision === 'granted' ? decision.intentId : null));

  if (intentId) {
    // **No `notes`, deliberately.** Closing this intent as `reverted` puts it through the
    // changefeed, which consolidates it — so passing `seedFact` here would consolidate the
    // same sentence twice, once explicitly below and once by that route. The demo showed
    // the result plainly: the seeded finding rendered `conf 0.60 · ×2`, semantic memory
    // claiming two independent corroborations for one event. Confidence is what a later
    // agent acts on, so overstating it is not cosmetic.
    //
    // Without notes the changefeed derives its own fact from the statement and outcome, a
    // different sentence, and inserts it as a finding of its own — which is honest: a
    // reverted intent really did close, and really should leave semantic memory behind.
    await close({
      repoId: options.sessionId,
      intentId,
      result: 'reverted',
      idempotencyKey: `seed-${intentId}`,
      ...scope,
    });
  }

  await consolidate({
    repoId: options.sessionId,
    fact: SCRIPT.seedFact,
    embedding,
    ...(intentId ? { sourceIntentId: intentId } : {}),
    ...scope,
  });

  return [
    {
      beat: 1,
      kind: 'seed',
      agent: 'agent-0',
      statement: SCRIPT.seedStatement,
      decision: 'seeded',
      detail: {
        note: `stands in for a session ${SEED_AGE_DAYS} days ago`,
        outcome: 'reverted',
      },
    },
  ];
}

/**
 * Runs one agent's step, and lets that agent re-plan once if the cluster refused it five
 * times running.
 *
 * **This is `03` §5's own instruction, not a workaround for it.** The retry helper is capped
 * at five attempts deliberately, and §5 says why in the next bullet: "Claim acquisition MUST
 * NOT wait on a contested key. Losing fast and re-planning is the desired behaviour;
 * blocking turns the fleet into a queue." An agent that exhausts the cap has lost fast.
 * What it does next is re-plan — and for an agent whose whole plan is one proposal, a
 * re-plan is proposing again. So it proposes again, once, and the fact that it had to is
 * carried into the step rather than hidden, because a demo that quietly retried until it
 * got the picture it wanted would be the fabrication this unit removed, in a new place.
 *
 * **Measured before it was written (V30).** Two genuinely concurrent proposals against this
 * cluster exhaust all five attempts on about one run in twelve; the naive arm's four
 * concurrent writers on one row did not exhaust them once in twelve. The conflict is real
 * and it is the mechanism working: both transactions read `intents` for this repo and both
 * write it, which is invariant 1 holding, and both write the same `claims` key, which is
 * the arbitration.
 *
 * **The retry helper is deliberately not changed here.** Raising its cap would contradict
 * `03` §5's five; widening its jitter would overturn a documented, tested property of
 * `backoffMs` — and either one changes the mechanism every write path in this project
 * depends on, on the strength of a demo. That is a decision for Julian, recorded in
 * `docs/DECISIONS.md` with the measurement, not one to take inside U16b.
 *
 * A second exhaustion returns `null`, and the caller reports it as what it is. It is not
 * an error and must never become one: `04` §5 invariant 1 admits no error page on any path
 * a visitor can reach, and this is the path behind the run button.
 */
async function replanOnce<T>(
  run: () => Promise<T>,
): Promise<{ value: T | null; replanned: boolean }> {
  try {
    return { value: await run(), replanned: false };
  } catch (error) {
    if (!isSerializationFailure(error)) throw error;
  }

  try {
    return { value: await run(), replanned: true };
  } catch (error) {
    if (!isSerializationFailure(error)) throw error;
    return { value: null, replanned: true };
  }
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

/**
 * One naive agent's whole life: read the shared state, do the work, write the state back.
 *
 * The three phases are three separate round trips and the middle one is not a database
 * operation at all — which is the point. A naive agent's work happens outside the database,
 * so its snapshot goes stale while it works and its save writes the stale snapshot back
 * over whatever landed in between. `bench/arms/naive.ts` proves the identical mechanism
 * against a file; `src/memory/shared-state.ts` explains why the read and the write must not
 * share a transaction.
 *
 * The work is the embedding call, and it is real work: the same live Bedrock request the
 * CORTEX arm makes for the same statement, taking however long it takes. Nothing here
 * sleeps. `U16b` §3b forbids simulating a delay to guarantee the overlap, and the overlap
 * does not need one — four agents that start together spend the same hundreds of
 * milliseconds thinking, and their saves land after all four snapshots were taken.
 */
async function naiveAgent(
  options: RunOptions,
  actor: Actor,
  keys: readonly string[],
  /** Stamps the order the saves actually returned in. See `finishedAt` below. */
  finished: () => number,
): Promise<{
  actor: Actor;
  keys: readonly string[];
  embedding: number[];
  knownWhenLoaded: number;
  acknowledged: boolean;
  /**
   * Where this agent's save landed in the real completion order, which `Promise.all` does
   * not preserve — it returns results in the order they were *asked for*. The order matters
   * because `duplicatesAmong` treats the first of a duplicate group as work that had to be
   * done and every later one as work that did not, so feeding it call order would name the
   * wrong agent as the duplicate whenever the race ran the other way.
   */
  finishedAt: number;
}> {
  const scope = planeFor(options);

  const snapshot = await loadSharedState(options.sessionId, scope);
  const knownWhenLoaded = Object.keys(snapshot.completed).length;

  const embedding = await options.embed(actor.statement);

  snapshot.completed[actor.agent] = {
    agent: actor.agent,
    statement: actor.statement,
    resourceKeys: [...keys],
    note: `edited ${keys.join(', ')}`,
  };

  // Four agents write the same row, so a 40001 is ordinary traffic here too, and an
  // exhausted retry is an agent that did not manage to save at all — which is a different
  // thing from a save that landed and was later reverted, and is counted as neither.
  const { value } = await replanOnce(() => saveSharedState(options.sessionId, snapshot, scope));

  return {
    actor,
    keys,
    embedding,
    knownWhenLoaded,
    acknowledged: (value ?? 0) > 0,
    finishedAt: finished(),
  };
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const steps: BeatStep[] = [];
  const retriesBefore = getRetryCount();
  const scope = planeFor(options);

  /**
   * What each arm actually did, in completion order. Both meters are derived from this and
   * from a readback — never from the script's expectations.
   */
  const workDone: WorkDone[] = [];
  let acknowledged: string[] = [];
  let surviving: string[] = [];
  let duplicates: DuplicatedWork[] = [];
  let duplicateWorkAvoided = 0;
  let blockedAndReplanned = 0;
  let findingsRecalled = 0;

  // ---- Beat 1 — recall -------------------------------------------------------------
  //
  // NAIVE gets no seed and no recall, and that is the whole contrast rather than a
  // handicap: an agent with no shared memory has nothing to be handed. `06` §2 draws the
  // arms exactly this way, and U12 found the same asymmetry honestly in the benchmark.
  if (options.arm === 'cortex') {
    steps.push(...(await seedPast(options)));

    const found = await recall({
      repoId: options.sessionId,
      embedding: await options.embed(SCRIPT.dedupeHolder.statement),
      plane: 'demo',
      demoSession: options.sessionId,
      ...(options.recorder ? { recorder: options.recorder } : {}),
    });
    findingsRecalled = found.length;

    steps.push({
      beat: 1,
      kind: 'recall',
      agent: 'agent-1',
      statement: 'what does this fleet already know about the orders client?',
      decision: found.length > 0 ? 'recalled' : 'nothing known',
      detail: {
        findings: found.map((f) => ({
          fact: f.fact,
          confidence: f.confidence,
          timesReverted: f.timesReverted,
        })),
      },
    });
  } else {
    // The naive fleet's only shared artifact is the work-state cell, and agent-1 really
    // does read it. It is empty, and the emptiness is measured rather than asserted: a
    // shared task file carries no findings from any earlier session, because no earlier
    // session had anywhere to put one.
    const known = await loadSharedState(options.sessionId, scope);

    steps.push({
      beat: 1,
      kind: 'recall',
      agent: 'agent-1',
      statement: 'what does this fleet already know about the orders client?',
      decision: 'nothing known',
      detail: {
        findings: [],
        entriesInSharedState: Object.keys(known.completed).length,
        note: 'no shared memory: a task file holds what was done, never what was learned',
      },
    });
  }

  // ---- Beats 2 and 3 ---------------------------------------------------------------
  let holderIntentId: string | null = null;

  if (options.arm === 'cortex') {
    // ---- Beat 2 — dedupe. A sequence, not a race; see this file's header. ----------
    const holderEmbedding = await options.embed(SCRIPT.dedupeHolder.statement);

    const holder = await propose({
      repoId: options.sessionId,
      agentId: SCRIPT.dedupeHolder.agent,
      statement: SCRIPT.dedupeHolder.statement,
      resourceKeys: [...SCRIPT.dedupeKeys],
      embedding: holderEmbedding,
      ...scope,
    });
    holderIntentId = holder.decision === 'granted' ? holder.intentId : null;
    if (holder.decision === 'granted') {
      workDone.push({
        key: SCRIPT.dedupeHolder.agent,
        statement: SCRIPT.dedupeHolder.statement,
        embedding: holderEmbedding,
      });
    }
    steps.push({
      beat: 2,
      kind: 'propose',
      agent: SCRIPT.dedupeHolder.agent,
      statement: SCRIPT.dedupeHolder.statement,
      decision: holder.decision,
      detail: { keys: SCRIPT.dedupeKeys },
    });

    const callerEmbedding = await options.embed(SCRIPT.dedupeCaller.statement);
    const caller = await propose({
      repoId: options.sessionId,
      agentId: SCRIPT.dedupeCaller.agent,
      statement: SCRIPT.dedupeCaller.statement,
      resourceKeys: [...SCRIPT.dedupeKeys],
      embedding: callerEmbedding,
      ...scope,
    });
    if (caller.decision === 'deduped') duplicateWorkAvoided += 1;
    if (caller.decision === 'granted') {
      workDone.push({
        key: SCRIPT.dedupeCaller.agent,
        statement: SCRIPT.dedupeCaller.statement,
        embedding: callerEmbedding,
      });
    }
    steps.push({
      beat: 2,
      kind: 'propose',
      agent: SCRIPT.dedupeCaller.agent,
      statement: SCRIPT.dedupeCaller.statement,
      decision: caller.decision,
      // `05` §1 requires a deduped agent to receive the prior outcome rather than a
      // rejection (invariant 4), and the panel shows what it received.
      detail: caller.decision === 'deduped' ? { of: caller.of, priorOutcome: caller.outcome } : {},
    });

    // ---- Beat 3 — claim. A real race. ----------------------------------------------
    //
    // Two proposals in flight at once, each borrowing its own connection from the demo
    // pool. Nothing below decides the winner and nothing below may assume it: the unique
    // index on `(repo_id, resource_key)` decides, the loser's transaction sees a 40001 or a
    // held key, and `withRetry` turns the first into the second. `07` §3 beat 3 says "in
    // the same instant" and until now that was the one word in the table that was not true.
    const contenders = [SCRIPT.contenderA, SCRIPT.contenderB] as const;
    const embeddings = await Promise.all(contenders.map((c) => options.embed(c.statement)));

    const raced = await Promise.all(
      contenders.map(
        async (
          contender,
          index,
        ): Promise<{
          actor: Actor;
          result: ProposeResult | null;
          replanned: boolean;
          at: number;
        }> => {
          const { value, replanned } = await replanOnce(() =>
            propose({
              repoId: options.sessionId,
              agentId: contender.agent,
              statement: contender.statement,
              resourceKeys: [...SCRIPT.claimKeys],
              embedding: embeddings[index]!,
              ...scope,
            }),
          );
          return { actor: contender, result: value, replanned, at: index };
        },
      ),
    );

    // Ordered by outcome, not by call order: the granted agent is reported first because it
    // is the one that happened first, whichever of the two it turned out to be.
    const rank = (result: ProposeResult | null) =>
      result === null ? 2 : result.decision === 'granted' ? 0 : 1;
    const ranked = [...raced].sort((a, b) => rank(a.result) - rank(b.result));

    for (const { actor, result, replanned, at } of ranked) {
      if (result?.decision === 'blocked') blockedAndReplanned += 1;
      if (result?.decision === 'granted') {
        workDone.push({ key: actor.agent, statement: actor.statement, embedding: embeddings[at]! });
      }

      const detail: Record<string, unknown> = { keys: SCRIPT.claimKeys };
      // Invariant 3: a blocked agent learns the holder and its intent, so it can re-plan
      // rather than poll. That is what makes this a decision and not a queue.
      if (result?.decision === 'blocked') detail['contested'] = result.contested;
      if (replanned) {
        detail['replanned'] = true;
        detail['note'] =
          'it lost five SERIALIZABLE attempts to the other agent and re-planned, ' +
          'which is what `03` §5 caps the retry helper for';
      }
      if (result === null) {
        detail['note'] =
          'two rounds of five SERIALIZABLE attempts and it still could not commit. It ' +
          'holds nothing and would come back — no work was done twice and none was lost';
      }

      steps.push({
        beat: 3,
        kind: 'propose',
        agent: actor.agent,
        statement: actor.statement,
        decision: result === null ? 'contended' : result.decision,
        detail,
      });
    }

    // The CORTEX half of `writes lost`, asked of the database rather than assumed. See
    // `DEMO_SURVIVING_WORK_SQL`.
    acknowledged = workDone.map((w) => w.key);
    surviving = await survivingWork(options.sessionId, acknowledged, {
      ...(options.recorder ? { recorder: options.recorder } : {}),
    });
  } else {
    // ---- NAIVE — every agent works, concurrently, and nothing arbitrates ------------
    //
    // All four run at once on their own pooled connections. There is no dedupe to make
    // agent-4 stand down and no claim to make agent-5 wait, so all four load, work and
    // save, and their saves collide. Which of them survives is decided by the ordering of
    // four real write statements, so it changes between runs — that is a property of the
    // race, and the page says so rather than implying a determinism it does not have.
    //
    // (The wording avoids spelling the verb out: `scripts/gate-mechanical.sh` greps `src/`
    // for SQL keywords to keep statements inside `src/memory/` and `src/db/`, and it does
    // not read code from prose. The guard is worth more than the sentence.)
    const cast: { actor: Actor; keys: readonly string[]; beat: 2 | 3 }[] = [
      { actor: SCRIPT.dedupeHolder, keys: SCRIPT.dedupeKeys, beat: 2 },
      { actor: SCRIPT.dedupeCaller, keys: SCRIPT.dedupeKeys, beat: 2 },
      { actor: SCRIPT.contenderA, keys: SCRIPT.claimKeys, beat: 3 },
      { actor: SCRIPT.contenderB, keys: SCRIPT.claimKeys, beat: 3 },
    ];

    let completions = 0;
    const outcomes = await Promise.all(
      cast.map((member) =>
        naiveAgent(options, member.actor, member.keys, () => (completions += 1)),
      ),
    );

    // `workDone` is built in the order the saves returned, not the order they were started.
    for (const outcome of [...outcomes].sort((a, b) => a.finishedAt - b.finishedAt)) {
      if (outcome.acknowledged) {
        workDone.push({
          key: outcome.actor.agent,
          statement: outcome.actor.statement,
          embedding: outcome.embedding,
        });
      }
    }

    // The steps stay in cast order, so the panel reads beat 2 then beat 3 however the race
    // resolved. Only the duplicate measurement above needs completion order.
    for (const [index, outcome] of outcomes.entries()) {
      const member = cast[index]!;
      steps.push({
        beat: member.beat,
        kind: 'propose',
        agent: outcome.actor.agent,
        statement: outcome.actor.statement,
        decision: outcome.acknowledged ? 'proceeded' : 'refused',
        detail: {
          keys: member.keys,
          knownWhenLoaded: outcome.knownWhenLoaded,
          note: 'nothing arbitrated: it read the shared file, did the work, and saved',
        },
      });
    }

    // The readback. `lostWrites` is the subtraction between what the agents were told they
    // had saved and what is still in the cell — two counted quantities, neither of them a
    // constant, and neither of them predictable before the race resolves.
    const final = await loadSharedState(options.sessionId, scope);
    acknowledged = outcomes.filter((o) => o.acknowledged).map((o) => o.actor.agent);
    surviving = acknowledged.filter((agent) => final.completed[agent] !== undefined);

    for (const agent of acknowledged) {
      const kept = surviving.includes(agent);
      const member = cast.find((c) => c.actor.agent === agent)!;
      steps.push({
        beat: member.beat,
        kind: 'close',
        agent,
        statement: member.actor.statement,
        decision: kept ? 'saved' : 'overwritten',
        detail: kept
          ? { note: 'its entry is in the shared file' }
          : {
              note:
                'its entry is gone: another agent saved a snapshot taken before this one ' +
                'landed, and the whole file went back with it',
              survivedInstead: surviving,
            },
      });
    }
  }

  // ---- The duplicate-work measurement, identical for both arms ----------------------
  //
  // `duplicatesAmong` applies the dedupe rule after the fact to whatever the arm actually
  // did, with the distances computed by the cluster. CORTEX's set excludes the agent that
  // was deduped, because it did no work; NAIVE's includes everybody. Same rule, same
  // threshold, two inputs — which is exactly the comparison `07` §2's toggle promises.
  duplicates = await duplicatesAmong(workDone, {
    threshold: DEFAULT_DEDUPE_THRESHOLD,
    plane: 'demo',
    demoSession: options.sessionId,
    ...(options.recorder ? { recorder: options.recorder } : {}),
  });

  for (const duplicate of duplicates) {
    const existing = steps.find(
      (step) => step.agent === duplicate.key && step.kind === 'propose',
    );
    if (existing) {
      existing.detail = {
        ...existing.detail,
        duplicateOf: duplicate.of,
        distance: Number(duplicate.distance.toFixed(4)),
        threshold: DEFAULT_DEDUPE_THRESHOLD,
      };
    }
  }

  // ---- Beat 4 — consolidate --------------------------------------------------------
  //
  // The close is all this does. The finding is written by the changefeed sink and arrives
  // over the WebSocket a moment later, which is what beat 4 shows — so this step reports
  // that the close happened and deliberately does not report a finding it has not seen.
  if (options.arm === 'cortex' && holderIntentId) {
    await close({
      repoId: options.sessionId,
      intentId: holderIntentId,
      result: 'done',
      idempotencyKey: `demo-close-${holderIntentId}`,
      notes: 'the 409 retry belongs in the orders client, not the server',
      ...scope,
    });
    steps.push({
      beat: 4,
      kind: 'close',
      agent: SCRIPT.dedupeHolder.agent,
      statement: SCRIPT.dedupeHolder.statement,
      decision: 'done',
      detail: {
        intentId: holderIntentId,
        awaiting: 'consolidation, arriving over the change stream',
      },
    });
  } else if (options.arm === 'naive') {
    // **Attributed to the fleet, not to an agent, and that is not cosmetic.** The fleet
    // panel renders one card per agent showing that agent's latest step, so hanging this
    // on agent-2 would overwrite the only thing its card has to say — whether its write
    // survived. Nothing consolidates here because *no* agent has anywhere to consolidate
    // to, which is a statement about the fleet; `agent-2` is not one of `07` §3's five
    // cards, so the card keeps its verdict and this step keeps its place in the beats.
    steps.push({
      beat: 4,
      kind: 'close',
      agent: 'fleet',
      statement: 'what does the next session inherit from this one?',
      decision: 'nothing consolidates',
      detail: {
        note: 'each outcome stayed local to the agent that produced it; there is no shared memory for it to become a finding in',
      },
    });
  }

  return {
    arm: options.arm,
    sessionId: options.sessionId,
    steps,
    meter: {
      duplicateWorkAvoided,
      duplicateWorkDone: duplicates.length,
      lostWrites: acknowledged.length - surviving.length,
      blockedAndReplanned,
      findingsRecalled,
      claimP50Ms: median(claimLatenciesMs(options.recorder?.statements ?? [])),
      serializationRetries: getRetryCount() - retriesBefore,
    },
  };
}
