/**
 * The five-agent runner, against the cluster named by CORTEX_DSN.
 *
 * U12's named silent break is "non-determinism leaking in through model calls or
 * wall-clock time, so two runs of the same arm disagree and the published number is
 * unreproducible". Every assertion here is aimed at that, and the shape of the aim
 * matters: the tests do not check that a run *looks* deterministic, they run each arm
 * **twice** and compare the two decision sequences. A determinism test that only
 * inspects one run cannot fail for the reason it exists.
 *
 * The CORTEX arm is not stubbed. It proposes and closes against the real cluster
 * through `src/memory/`, so a passing determinism test also means the arbitration
 * transaction produced the same decisions twice against a live SERIALIZABLE database.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool } from '../src/db/pool.js';
import { CassetteStore, reasonKey } from '../bench/cassettes.js';
import { reasonPrompt } from '../bench/reason.js';
import { assign } from '../bench/arms/shared.js';
import { runArm, DEFAULT_AGENTS, DEFAULT_SEED } from '../bench/run.js';
import { TASKS } from '../bench/tasks.js';
import { deterministicPart, type RunRecord } from '../bench/types.js';

/** A fresh working directory per run: two runs must not inherit each other's state. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'cortex-bench-test-'));
}

const MINUTE = 60_000;

/**
 * Four full runs, once, shared by every assertion below.
 *
 * The CORTEX arm is ~120 sequential round trips to CockroachDB Cloud, so a run costs
 * a minute and a half of wall clock. Running it per assertion would put the suite out
 * of anyone's patience, and a suite nobody runs catches nothing.
 */
const runs: { naive: RunRecord[]; cortex: RunRecord[] } = { naive: [], cortex: [] };

beforeAll(async () => {
  runs.naive = [
    await runArm({ arm: 'naive', runDir: freshDir() }),
    await runArm({ arm: 'naive', runDir: freshDir() }),
  ];
  runs.cortex = [
    await runArm({ arm: 'cortex', runDir: freshDir() }),
    await runArm({ arm: 'cortex', runDir: freshDir() }),
  ];
}, 8 * MINUTE);

afterAll(async () => {
  await closePool();
});

describe('cassette coverage (§5)', () => {
  it('has a recorded reasoning cassette for every task in the list', async () => {
    const store = new CassetteStore('replay');
    const model = process.env.BEDROCK_REASON_MODEL ?? '';
    expect(model).not.toBe('');

    const missing: string[] = [];
    for (const task of TASKS) {
      try {
        // Rejects with CassetteMiss if the cassette is absent; the value is
        // irrelevant, and `produce` is unreachable in replay mode.
        await store.reason(model, reasonPrompt(task), async () => ({}));
      } catch {
        missing.push(task.id);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('task assignment (§4)', () => {
  it('deals every task exactly once, and the same way for both arms', () => {
    const fleet = assign(TASKS, DEFAULT_AGENTS, DEFAULT_SEED);
    const dealt = fleet.flatMap((agent) => agent.queue.map((task) => task.id));

    expect(dealt.length).toBe(TASKS.length);
    expect(new Set(dealt).size).toBe(TASKS.length);

    const again = assign(TASKS, DEFAULT_AGENTS, DEFAULT_SEED);
    expect(again.map((a) => a.queue.map((t) => t.id))).toEqual(
      fleet.map((a) => a.queue.map((t) => t.id)),
    );
  });

  it('gives a different seed a different deal, or the seed does nothing', () => {
    const a = assign(TASKS, DEFAULT_AGENTS, DEFAULT_SEED);
    const b = assign(TASKS, DEFAULT_AGENTS, DEFAULT_SEED + 1);
    expect(b.map((x) => x.queue.map((t) => t.id))).not.toEqual(
      a.map((x) => x.queue.map((t) => t.id)),
    );
  });
});

describe('NAIVE arm', () => {
  it('runs the same workload twice and decides identically', () => {
    const [first, second] = runs.naive as [RunRecord, RunRecord];
    expect(deterministicPart(second)).toEqual(deterministicPart(first));
  });

  it('replays without reaching Bedrock', () => {
    expect(runs.naive[0]!.cassettes.liveCalls).toEqual({ embed: 0, reason: 0 });
  });

  it('loses writes to its shared file, structurally rather than by script', () => {
    const first = runs.naive[0]!;
    const completed = first.acknowledged.filter((entry) => entry.result === 'done');
    const survived = new Set(first.finalState);
    const lost = completed.filter((entry) => !survived.has(entry.taskId));

    // §1: "if `lost_writes` is zero in the naive arm, the thesis is wrong and you
    // should say so in the README". This asserts the harness can observe the failure
    // at the shipped seed — not that losing writes is desirable.
    expect(lost.length).toBeGreaterThan(0);
  });
});

describe('CORTEX arm', () => {
  it('runs the same workload twice against the real cluster and decides identically', () => {
    const [first, second] = runs.cortex as [RunRecord, RunRecord];
    expect(deterministicPart(second)).toEqual(deterministicPart(first));
  });

  it('replays without reaching Bedrock', () => {
    expect(runs.cortex[0]!.cassettes.liveCalls).toEqual({ embed: 0, reason: 0 });
  });

  it('loses no acknowledged write', () => {
    const first = runs.cortex[0]!;
    const completed = first.acknowledged.filter((entry) => entry.result === 'done');
    const survived = new Set(first.finalState);
    expect(completed.filter((entry) => !survived.has(entry.taskId))).toEqual([]);
  });

  it('actually contends and actually dedupes at the shipped seed', () => {
    const first = runs.cortex[0]!;
    const outcomes = first.decisions.filter((d) => d.kind === 'propose').map((d) => d.outcome);

    // `08` §7: a benchmark showing no difference means overlap is too low, not that
    // the mechanism does not work. If either of these is zero the seed or the task
    // list needs fixing before any number is published — which is precisely the
    // failure this assertion exists to catch early.
    expect(outcomes.filter((o) => o === 'blocked').length).toBeGreaterThan(0);
    expect(outcomes.filter((o) => o === 'deduped').length).toBeGreaterThan(0);
  });

  it('spends no work tokens on a deduped task', () => {
    const first = runs.cortex[0]!;
    const deduped = [
      ...new Set(first.decisions.filter((d) => d.outcome === 'deduped').map((d) => d.taskId)),
    ].sort();
    const worked = new Set(first.decisions.filter((d) => d.kind === 'work').map((d) => d.taskId));

    // The saving the whole arm exists to produce. A deduped task that also reached the
    // work step would move `wasted_tokens` the wrong way and leave
    // `duplicate_work_rate` measuring nothing at all.
    expect(deduped.filter((taskId) => worked.has(taskId))).toEqual([]);
    expect(deduped.length).toBeGreaterThan(0);
  });
});

describe('both arms (§5)', () => {
  it('draw on the same cassette library, and CORTEX draws strictly less of it', () => {
    const naive = runs.naive[0]!;
    const cortex = runs.cortex[0]!;

    // The methodological point: same reasoning, same embeddings, different
    // coordination layer. Every arm embeds every task it attempts, so the embedding
    // sets are equal — if they were not, a difference in the results could be a
    // difference in what was asked rather than in how the fleet coordinated.
    expect(cortex.cassettes.embedKeys).toEqual(naive.cassettes.embedKeys);

    // The reasoning sets are not equal, and must not be. NAIVE reasons about every
    // task; CORTEX skips the ones it dedupes, which is the saving being measured.
    // Same library, fewer draws.
    const library = new Set(naive.cassettes.reasonKeys);
    expect(cortex.cassettes.reasonKeys.filter((key) => !library.has(key))).toEqual([]);
    expect(cortex.cassettes.reasonKeys.length).toBeLessThan(naive.cassettes.reasonKeys.length);
    expect(naive.cassettes.reasonKeys.length).toBe(TASKS.length);
  });
});
