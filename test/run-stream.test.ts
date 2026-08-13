/**
 * THE RUN STREAM'S GUARDS — the named silent break of U22, and the two paths it hides on.
 *
 * `docs/UNITS.md` U22: "a run that dies after `POST /demo/run` has already returned 200. The
 * visitor gets a page that never finishes and never errors — invariant 1 satisfied to the letter
 * and broken in spirit. Every path through the runner must emit a terminal event, including the
 * paths that throw."
 *
 * There are **two** such paths and only one of them is a throw. The other is the runner Lambda
 * reaching its own timeout, which kills the process without running a single `finally` — so a
 * `try/finally` around the run is not the guard it looks like. Both are asserted below, and the
 * watchdog that answers the second lives in this module rather than in `infra/lambda/runner.ts`
 * precisely so that a test can force it: a terminal event that only exists in AWS code is a
 * terminal event nobody has seen fire.
 *
 * **The arm runner is faked here, deliberately, and that is not a mock standing in for the data
 * layer.** `runArm` is live-tested by `npm run gate:workload` against the real cluster, eleven
 * tickets across two arms; what this file is about is what happens to the *stream* when a run
 * throws, stalls, or publishes into a broken socket, and none of those are reproducible against a
 * healthy cluster on demand. The live end of U22 is `npm run gate:async`, which posts to the
 * deployed API and reads the whole run off the real WebSocket.
 */
import { describe, expect, it } from 'vitest';

import { streamRun, type RunMessage } from '../src/demo/run.js';
import type { ArmResult, FleetEvent } from '../src/demo/workload.js';

const SCOPES = { cortex: 'scope-cortex', naive: 'scope-naive' };

function armResult(arm: 'cortex' | 'naive', events: FleetEvent[]): ArmResult {
  return {
    arm,
    sessionId: SCOPES[arm],
    steps: [],
    spans: [],
    events,
    tree: {},
    beats: { recall: false, dedupe: false, collision: false, consolidate: false },
    meter: {
      duplicateWorkAvoided: 0,
      duplicateWorkDone: 0,
      lostWrites: 0,
      blockedAndReplanned: 0,
      findingsRecalled: 0,
      agentsSpared: 0,
      deadEndsWalked: 0,
      conflictingEdits: 0,
      fileCollisions: 0,
      embeddingCalls: 0,
      claimP50Ms: null,
      serializationRetries: 0,
      wastedTokens: null,
    },
  };
}

/** An arm that emits `count` events through `onEvent` and returns them, as `runArm` does. */
function emitting(count: number) {
  return async (options: {
    arm: 'cortex' | 'naive';
    onEvent?: (event: FleetEvent) => void;
  }): Promise<ArmResult> => {
    const events: FleetEvent[] = [];
    for (let seq = 1; seq <= count; seq += 1) {
      const event: FleetEvent = {
        seq,
        arm: options.arm,
        agent: `agent-${seq}`,
        taskId: `T${seq}`,
        phase: 'started',
        at: seq,
      };
      events.push(event);
      options.onEvent?.(event);
    }
    return armResult(options.arm, events);
  };
}

const sink = () => {
  const published: RunMessage[] = [];
  return { published, publish: (message: RunMessage) => void published.push(message) };
};

const terminals = (published: RunMessage[]) =>
  published.filter((m) => m.type === 'run' && (m.phase === 'finished' || m.phase === 'failed'));

const embed = async () => [0];

describe('the terminal event — U22’s named silent break', () => {
  it('emits one when the run throws', async () => {
    const { published, publish } = sink();

    await streamRun({
      runId: 'run-1',
      scopes: SCOPES,
      embed,
      publish,
      run: async () => {
        throw new Error('the cluster went away mid-run');
      },
    });

    const terminal = terminals(published);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'run', runId: 'run-1', phase: 'failed' });
    // The reason is the whole value of the event: a page that says "the run stopped" and cannot
    // say why is a page that looks broken rather than one that reports a break.
    expect((terminal[0] as { reason: string }).reason).toContain('the cluster went away mid-run');
  });

  /**
   * The path a `try/finally` cannot cover. In Lambda the process is killed at the deadline, so
   * the terminal event has to be published *before* it, by a watchdog, against a run that has
   * not returned and is not going to.
   */
  it('emits one when the run outlives its budget, without waiting for the run', async () => {
    const { published, publish } = sink();

    const started = Date.now();
    await streamRun({
      runId: 'run-2',
      scopes: SCOPES,
      embed,
      publish,
      budgetMs: 60,
      run: () => new Promise<ArmResult>(() => {}),
    });
    const elapsed = Date.now() - started;

    const terminal = terminals(published);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ phase: 'failed' });
    expect((terminal[0] as { reason: string }).reason).toMatch(/budget/i);
    // Returned on the watchdog rather than on the run, which never settles at all.
    expect(elapsed).toBeLessThan(5_000);
  });

  /**
   * The watchdog path again, from the other side: when the budget expires the run is **still
   * going and still emitting**, so a channel closed after the terminal message is queued leaves a
   * window for a late fleet event to land behind it. A page reading the stream in order would
   * then see work continue after being told the run was over.
   *
   * Written after the first version of `streamRun` had exactly that hole. It published the
   * terminal message and only then set the flag, and every other test passed — the healthy path
   * has no run left to emit anything.
   */
  it('lets nothing follow the terminal message when the run is still going', async () => {
    const published: RunMessage[] = [];
    let late = 0;

    await streamRun({
      runId: 'run-2b',
      scopes: SCOPES,
      embed,
      budgetMs: 60,
      /**
       * **Asynchronous on purpose, and the test is worthless without it.** The first version of
       * this used the synchronous sink above and passed against the very defect it was written
       * for: a sync publish drains entirely in microtasks, so the closing window shuts before any
       * timer can fire. The real publish is a DynamoDB scan and a socket post — tens of
       * milliseconds, spanning macrotasks — which is exactly what lets a still-emitting run slip
       * an event in behind the terminal message.
       */
      publish: async (message) => {
        await new Promise((r) => setTimeout(r, 2));
        published.push(message);
      },
      run: async (options) => {
        // Keeps emitting well past the budget, which is what a stalled-but-alive run does.
        for (let seq = 1; seq <= 60; seq += 1) {
          await new Promise((r) => setTimeout(r, 1));
          late += 1;
          options.onEvent?.({
            seq,
            arm: options.arm,
            agent: 'agent-1',
            taskId: 'T1',
            phase: 'started',
            at: seq,
          });
        }
        return armResult(options.arm, []);
      },
    });

    // **The wait is the assertion.** `streamRun` resolving does not end the process: the runner
    // still writes two transcripts afterwards, and the stalled arm keeps emitting the whole time.
    // Checking the instant it returns cannot see a late event, because the publishes that would
    // carry one have not had their turn yet — which is how the first two versions of this test
    // passed against the defect.
    await new Promise((r) => setTimeout(r, 150));

    // Non-vacuity: the run really was still emitting when the budget expired.
    expect(late).toBeGreaterThan(5);

    const terminal = terminals(published);
    expect(terminal).toHaveLength(1);
    expect(published.at(-1)).toBe(terminal[0]);
  });

  it('emits exactly one on the ordinary path, after the last fleet event', async () => {
    const { published, publish } = sink();

    await streamRun({ runId: 'run-3', scopes: SCOPES, embed, publish, run: emitting(3) });

    const terminal = terminals(published);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ phase: 'finished' });
    expect(published.at(-1)).toBe(terminal[0]);
  });

  /**
   * One unreachable socket is not a dead run. `changefeed.ts` already takes this position for
   * changefeed rows — "one bad socket must not cost the rest of the batch its delivery" — and a
   * run that abandoned itself because a browser closed its tab would be the same defect wearing
   * the opposite mask.
   */
  it('survives a publish that throws, and still terminates', async () => {
    const published: RunMessage[] = [];
    let failures = 0;

    await streamRun({
      runId: 'run-4',
      scopes: SCOPES,
      embed,
      run: emitting(3),
      publish: (message) => {
        // One arm's one event. `emitting` runs for both arms, so a condition on `seq` alone
        // fires twice and would have this assert a coincidence rather than the rule.
        if (message.type === 'fleet' && message.event.arm === 'cortex' && message.event.seq === 2) {
          failures += 1;
          throw new Error('410 gone');
        }
        published.push(message);
      },
    });

    expect(failures).toBe(1);
    const terminal = terminals(published);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ phase: 'finished' });
    expect((terminal[0] as { undelivered: number }).undelivered).toBe(1);
  });
});

describe('the whole run arrives, in order', () => {
  it('publishes every fleet event both arms produced, exactly once', async () => {
    const { published, publish } = sink();

    const summary = await streamRun({
      runId: 'run-5',
      scopes: SCOPES,
      embed,
      publish,
      run: emitting(4),
    });

    const fleet = published.filter((m) => m.type === 'fleet');
    expect(fleet).toHaveLength(8);
    expect(summary.arms.map((a) => a.arm)).toEqual(['cortex', 'naive']);

    for (const arm of ['cortex', 'naive'] as const) {
      const mine = fleet.filter((m) => m.type === 'fleet' && m.event.arm === arm);
      expect(mine.map((m) => (m as { event: FleetEvent }).event.seq)).toEqual([1, 2, 3, 4]);
      // Each event names the scope it happened in, because the two arms are two `repos` rows
      // now (design §4.1) and a page that cannot tell them apart cannot label the swimlanes.
      expect(new Set(mine.map((m) => (m as { scope: string }).scope))).toEqual(
        new Set([SCOPES[arm]]),
      );
    }
  });

  it('starts with a run message naming both scopes, so a page can subscribe before events land', async () => {
    const { published, publish } = sink();

    await streamRun({ runId: 'run-6', scopes: SCOPES, embed, publish, run: emitting(1) });

    expect(published[0]).toMatchObject({ type: 'run', phase: 'started', scopes: SCOPES });
  });
});

/**
 * Design §5.3: "Fleet events are **not** written as rows... The page labels the two sources
 * differently so nothing implies a fleet event has a primary key it does not have."
 *
 * The changefeed's messages are `{type: 'change', topic, scope, after}` and carry the row's own
 * key. Nothing this module publishes may be mistakable for one — not by its discriminator and not
 * by carrying a field a reader would read as a primary key.
 */
describe('a fleet event is not a row — design §5.3', () => {
  it('never publishes a change-shaped message', async () => {
    const { published, publish } = sink();

    await streamRun({ runId: 'run-7', scopes: SCOPES, embed, publish, run: emitting(2) });

    expect(published.length).toBeGreaterThan(0);
    for (const message of published) {
      expect(message.type).not.toBe('change');
      expect(message).not.toHaveProperty('topic');
      expect(message).not.toHaveProperty('after');
      expect(message).not.toHaveProperty('key');
      expect(message).not.toHaveProperty('id');
      expect(message).not.toHaveProperty('updated');
    }
  });
});
