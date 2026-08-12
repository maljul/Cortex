/**
 * CONSOLIDATION — episodic to semantic. spec/03-MEMORY-MODEL.md §4.4.
 *
 * This is the mechanism `07` §3 beat 4 shows and the video is told to name out loud: a
 * closed intent becomes a durable finding, so the memory *improves* rather than merely
 * accumulating. It runs off the critical path, triggered by the changefeed U14 deployed.
 *
 * **Invariant 5 is the one at risk here, and it is at risk in its most dangerous form.**
 * The candidate search is a vector query, and V5 measured a vector query without its
 * `repo_id` filter falling back to a full scan and returning *another repository's* rows
 * — the index prefix does not isolate tenants and a forgotten filter fails open. What
 * that would mean here is worse than a leak: consolidation would reinforce one
 * repository's finding on the strength of another's outcome, corrupting semantic memory
 * with a confidence score that looks earned. The cross-repository test below is the
 * assertion this file exists for.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import {
  CONSOLIDATION_DISTANCE,
  CONSOLIDATE_CANDIDATE_SQL,
  consolidate,
  consolidateClosedIntent,
  factFromClosedIntent,
} from '../src/memory/consolidate.js';

import { paraphraseOf, vector } from './helpers/vectors.js';

const repos: string[] = [];

/** A repository of its own, so no test can consolidate into another's findings. */
async function freshRepo(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO repos (slug) VALUES ($1) RETURNING id',
    [`consolidate-test/${randomUUID()}`],
  );
  const id = rows[0]!.id;
  repos.push(id);
  return id;
}

async function findingsIn(repoId: string): Promise<
  { id: string; fact: string; confidence: number; corroborations: number }[]
> {
  const { rows } = await getPool().query(
    `SELECT id, fact, confidence, corroborations
       FROM findings WHERE repo_id = $1 ORDER BY last_confirmed_at`,
    [repoId],
  );
  return rows.map((r) => ({
    id: r.id,
    fact: r.fact,
    confidence: Number(r.confidence),
    corroborations: Number(r.corroborations),
  }));
}

beforeAll(async () => {
  // Fail loudly here rather than in every test if the migration has not been applied.
  await getPool().query('SELECT 1 FROM findings LIMIT 1');
});

afterAll(async () => {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  for (const repo of repos) {
    await admin.query('DELETE FROM findings WHERE repo_id = $1', [repo]);
    await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
  }
  await admin.end();
  await closePool();
});

describe('inserting a finding that is genuinely new', () => {
  it('inserts when semantic memory holds nothing like it', async () => {
    const repo = await freshRepo();

    const result = await consolidate({
      repoId: repo,
      fact: 'the orders service retries 409s but not 429s',
      embedding: vector(101),
    });

    expect(result.action).toBe('inserted');
    expect(await findingsIn(repo)).toHaveLength(1);
  });

  it('inserts rather than reinforcing when the nearest finding is far away', async () => {
    const repo = await freshRepo();

    await consolidate({ repoId: repo, fact: 'first fact', embedding: vector(102) });
    // A different seed is near-orthogonal in 1024 dimensions — distance around 1.0,
    // which is nowhere near §4.4's 0.20.
    await consolidate({ repoId: repo, fact: 'unrelated fact', embedding: vector(103) });

    expect(await findingsIn(repo)).toHaveLength(2);
  });
});

describe('reinforcing a finding the fleet has now seen twice', () => {
  it('increments corroborations and raises confidence instead of inserting', async () => {
    const repo = await freshRepo();
    const base = vector(110);

    const first = await consolidate({ repoId: repo, fact: 'migrations run before boot', embedding: base });
    expect(first.action).toBe('inserted');

    // A paraphrase: the same thing learned again, worded differently. This is the case
    // §4.4 exists for — the alternative is two findings saying one thing, which is
    // accumulation rather than improvement.
    const second = await consolidate({
      repoId: repo,
      fact: 'boot waits for migrations',
      embedding: paraphraseOf(base, 111, 0.02),
    });

    expect(second.action).toBe('reinforced');
    if (second.action !== 'reinforced') return;
    expect(second.distance).toBeLessThan(CONSOLIDATION_DISTANCE);

    const findings = await findingsIn(repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.corroborations).toBe(2);
    expect(findings[0]?.confidence).toBeCloseTo(0.6, 5);
    // The *original* wording survives. A reinforcement is evidence that the fact holds,
    // not an instruction to restate it, and overwriting would lose the earlier phrasing
    // for no gain.
    expect(findings[0]?.fact).toBe('migrations run before boot');
  });

  it('caps confidence at 1.0 however many times it is corroborated', async () => {
    const repo = await freshRepo();
    const base = vector(120);

    await consolidate({ repoId: repo, fact: 'a fact worth confirming', embedding: base });
    for (let i = 0; i < 8; i += 1) {
      await consolidate({
        repoId: repo,
        fact: `restatement ${i}`,
        embedding: paraphraseOf(base, 200 + i, 0.02),
      });
    }

    const findings = await findingsIn(repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.corroborations).toBe(9);
    // 0.5 + 8 × 0.1 would be 1.3 without `least(1.0, …)`, and a confidence above 1.0
    // violates the schema's own CHECK — so this is the difference between a capped
    // value and a failed transaction.
    expect(findings[0]?.confidence).toBe(1);
  });
});

describe('the candidate search is scoped to its repository — invariant 5', () => {
  it('carries WHERE repo_id in the SQL', () => {
    expect(CONSOLIDATE_CANDIDATE_SQL).toMatch(/repo_id\s*=\s*\$1/);
  });

  /**
   * V5's failure, reproduced as a test rather than trusted to a comment. Two repositories
   * hold findings whose embeddings are nearly identical. Consolidating into one must not
   * see, and must not reinforce, the other's row — even though the vector index would
   * happily rank it first.
   */
  it('does not reinforce another repository findings, however close they are', async () => {
    const theirs = await freshRepo();
    const ours = await freshRepo();
    const base = vector(130);

    await consolidate({ repoId: theirs, fact: 'their hard-won finding', embedding: base });

    const result = await consolidate({
      repoId: ours,
      fact: 'our finding, worded almost identically',
      embedding: paraphraseOf(base, 131, 0.01),
    });

    expect(result.action).toBe('inserted');

    const theirFindings = await findingsIn(theirs);
    expect(theirFindings).toHaveLength(1);
    // Untouched: still the confidence and corroboration count it was inserted with.
    expect(theirFindings[0]?.corroborations).toBe(1);
    expect(theirFindings[0]?.confidence).toBeCloseTo(0.5, 5);

    expect(await findingsIn(ours)).toHaveLength(1);
  });
});

describe('flow D — a closed intent arriving from the changefeed', () => {
  const embed = async (text: string): Promise<number[]> => vector(text.length + 300);

  it('consolidates a row that transitioned to done', async () => {
    const repo = await freshRepo();
    const intentId = randomUUID();

    const result = await consolidateClosedIntent(
      {
        id: intentId,
        repo_id: repo,
        statement: 'add a retry to the orders client',
        status: 'done',
        outcome: { result: 'ok', notes: 'the 409 retry belongs in the client, not the server' },
      },
      { embed },
    );

    expect(result?.action).toBe('inserted');
    expect((await findingsIn(repo))[0]?.fact).toBe(
      'the 409 retry belongs in the client, not the server',
    );
  });

  /**
   * An abandoned intent is a concluded investigation, and what it concluded is worth more
   * than most successes.
   *
   * The case this exists for: an agent is asked to migrate to a payment provider's v3 API,
   * spends real tokens finding out the API is not available on this account, and gives up.
   * Before 2026-08-12 that sentence was written into `intents.outcome` and was then
   * reachable by **nobody** — `consolidateClosedIntent` ignored it, the changefeed sink
   * ignored it, and `findDuplicate`'s candidate set excludes `abandoned`. So the fleet paid
   * for the knowledge and threw it away, and the next agent paid for it again.
   */
  it('consolidates an abandoned intent — the most expensive thing the fleet learns', async () => {
    const repo = await freshRepo();

    const result = await consolidateClosedIntent(
      {
        id: randomUUID(),
        repo_id: repo,
        statement: 'Migrate the payment provider integration to their version three API',
        status: 'abandoned',
        outcome: {
          result: 'abandoned',
          notes: "The provider's v3 API is not available on this account, so the work cannot be completed.",
        },
      },
      { embed },
    );

    expect(result?.action).toBe('inserted');
    expect((await findingsIn(repo))[0]?.fact).toBe(
      "The provider's v3 API is not available on this account, so the work cannot be completed.",
    );
  });

  /**
   * **What is embedded is not what is stored, and only for abandonment.**
   *
   * Measured on 2026-08-12 against live Titan, and it inverted the obvious answer. A1's
   * abandonReason — "The provider's v3 API is not available on this account" — sits
   * **0.6725–0.7246** from every wording of the task that needs the warning, which is
   * outside recall's 0.60. The bare fallback `"<statement> — abandoned"` sits at
   * **0.4698–0.4899** and is retrieved by all of them. Writing both into one sentence lands
   * at 0.6022–0.6090 and still misses.
   *
   * The cause is not subtle once seen: an abandonment note describes the **obstacle**, and
   * the task that needs it describes the **work**. Titan has no reason to place those near
   * each other. So the agent that explains itself carefully produced a finding nobody could
   * retrieve, and the agent that said nothing produced one that worked — which is a terrible
   * property to ship.
   *
   * `consolidate()` already takes `fact` and `embedding` as separate arguments, so the fix
   * is to embed the statement-shaped key while storing the reason as the fact. The finding
   * then reads as *why it failed* and is found by *the work it concerns*.
   *
   * Scoped to abandonment deliberately: a `done` intent's notes share vocabulary with its
   * work, and V28 measured the seed's finding at 0.3801 from its task on exactly that basis.
   * Changing it for `done` would move a number beat 1 depends on.
   */
  it('embeds the work, not the obstacle, when an intent is abandoned', async () => {
    const repo = await freshRepo();
    const embedded: string[] = [];

    await consolidateClosedIntent(
      {
        id: randomUUID(),
        repo_id: repo,
        statement: 'Migrate the payment provider integration to their version three API',
        status: 'abandoned',
        outcome: {
          result: 'abandoned',
          notes: "The provider's v3 API is not available on this account, so the work cannot be completed.",
        },
      },
      {
        embed: async (text: string) => {
          embedded.push(text);
          return vector(text.length + 300);
        },
      },
    );

    // The retrieval key names the work, so a later agent reaching for the same thing finds it.
    expect(embedded).toEqual([
      'Migrate the payment provider integration to their version three API — abandoned',
    ]);

    // The stored fact is still the reason, because that is what the agent needs to read.
    expect((await findingsIn(repo))[0]?.fact).toBe(
      "The provider's v3 API is not available on this account, so the work cannot be completed.",
    );
  });

  it('still embeds the fact itself for a completed intent', async () => {
    const repo = await freshRepo();
    const embedded: string[] = [];

    await consolidateClosedIntent(
      {
        id: randomUUID(),
        repo_id: repo,
        statement: 'add a retry to the orders client',
        status: 'done',
        outcome: { result: 'ok', notes: 'the 409 retry belongs in the client, not the server' },
      },
      {
        embed: async (text: string) => {
          embedded.push(text);
          return vector(text.length + 300);
        },
      },
    );

    // Unchanged, and the reason it must stay unchanged is measurable: V28 put the demo's
    // seeded finding at 0.3801 from the task that recalls it, on the strength of embedding
    // the note. Beat 1 fires because of that number.
    expect(embedded).toEqual(['the 409 retry belongs in the client, not the server']);
  });

  it('falls back to statement and result when an abandoning agent left no notes', async () => {
    const repo = await freshRepo();

    await consolidateClosedIntent(
      {
        id: randomUUID(),
        repo_id: repo,
        statement: 'Migrate the payment provider integration to their version three API',
        status: 'abandoned',
        outcome: { result: 'abandoned' },
      },
      { embed },
    );

    // Honest rather than silent: the finding says the work was abandoned even when the
    // agent could not say why, which is still more than the next agent knew before.
    expect((await findingsIn(repo))[0]?.fact).toBe(
      'Migrate the payment provider integration to their version three API — abandoned',
    );
  });

  /**
   * Everything a changefeed on `intents` emits that is *not* a concluded outcome. Each of
   * these would otherwise become a finding asserting something that has not happened yet —
   * `proposed` in particular is an intention, and semantic memory that records intentions
   * as facts is worse than no semantic memory.
   *
   * **`abandoned` used to be in this list and was moved out on 2026-08-12 (U21).** It does
   * not belong with the other three and the grouping was the mistake: `proposed` and
   * `in_flight` are unfinished, and `deduped` is work that deliberately never happened —
   * none of them has an outcome. An abandoned intent is a **finished investigation with a
   * real result**, and it is the most expensive knowledge the fleet produces, because an
   * agent spent tokens discovering it. Keeping it out meant the memory model discarded
   * exactly what cost the most to learn and kept the cheap successes. See the tests below,
   * `docs/DECISIONS.md`, and the `03` §4.4 deviation in `docs/SPEC-DELTA.md`.
   */
  it.each([
    { status: 'proposed', why: 'not started' },
    { status: 'in_flight', why: 'still running' },
    { status: 'deduped', why: 'work that deliberately did not happen' },
  ])('ignores a row arriving as $status ($why)', async ({ status }) => {
    const repo = await freshRepo();

    const result = await consolidateClosedIntent(
      { id: randomUUID(), repo_id: repo, statement: 'something', status, outcome: null },
      { embed },
    );

    expect(result).toBeNull();
    expect(await findingsIn(repo)).toHaveLength(0);
  });

  it('falls back to the statement and result when the agent left no notes', () => {
    expect(
      factFromClosedIntent({
        statement: 'rename the column',
        status: 'done',
        outcome: { result: 'reverted' },
      }),
    ).toBe('rename the column — reverted');
  });

  it('has nothing to say about a row with no statement', () => {
    expect(factFromClosedIntent({ status: 'done', outcome: { notes: 'x' } })).toBeNull();
  });

  /**
   * A revert is the most valuable thing recall can hand the next agent — `recall` orders
   * by `times_reverted` ahead of distance — and it reaches that ordering through
   * `source_intent_id`. Dropping reverts here would quietly delete the one signal `03`
   * §4.1 ranks first.
   */
  it('consolidates a reverted outcome, carrying the intent id that makes it findable', async () => {
    const repo = await freshRepo();
    const intentId = randomUUID();

    const result = await consolidateClosedIntent(
      {
        id: intentId,
        repo_id: repo,
        statement: 'switch the queue driver',
        status: 'done',
        outcome: { result: 'reverted', notes: 'the queue driver switch broke ordering' },
      },
      { embed },
    );
    expect(result?.action).toBe('inserted');

    const { rows } = await getPool().query<{ source_intent_id: string | null }>(
      'SELECT source_intent_id FROM findings WHERE repo_id = $1',
      [repo],
    );
    expect(rows[0]?.source_intent_id).toBe(intentId);
  });
});

describe('what a consolidated finding remembers about where it came from', () => {
  it('records the intent that produced it', async () => {
    const repo = await freshRepo();
    const intentId = randomUUID();

    const result = await consolidate({
      repoId: repo,
      fact: 'a fact with a provenance',
      embedding: vector(140),
      sourceIntentId: intentId,
    });
    expect(result.action).toBe('inserted');

    const { rows } = await getPool().query<{ source_intent_id: string | null }>(
      'SELECT source_intent_id FROM findings WHERE repo_id = $1',
      [repo],
    );
    expect(rows[0]?.source_intent_id).toBe(intentId);
  });
});
