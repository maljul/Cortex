/**
 * RECALL — the read path, against the cluster named by CORTEX_DSN.
 * spec/03-MEMORY-MODEL.md §4.1.
 *
 * Covers invariant 8 of §8: recall scoped to repo A never returns rows belonging
 * to repo B. The rest of the file pins the part of the query that is the actual
 * argument — semantic similarity and structural outcome history resolved in one
 * statement, on one snapshot.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import { close } from '../src/memory/close.js';
import { propose } from '../src/memory/propose.js';
import { DEFAULT_MAX_DISTANCE, recall } from '../src/memory/recall.js';
import { cosineDistance, paraphraseOf, vector } from './helpers/vectors.js';

function freshRepo(): string {
  return randomUUID();
}

async function insertFinding(
  repoId: string,
  fact: string,
  embedding: readonly number[],
  options: { sourceIntentId?: string; confidence?: number } = {},
): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO findings (repo_id, fact, embedding, source_intent_id, confidence)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      repoId,
      fact,
      `[${embedding.join(',')}]`,
      options.sourceIntentId ?? null,
      options.confidence ?? 0.5,
    ],
  );
  return (rows[0] as { id: string }).id;
}

/** A closed intent whose outcome carries `result`, for the history half of §4.1. */
async function closedIntent(
  repoId: string,
  agentId: string,
  statement: string,
  key: string,
  seed: number,
  result: 'done' | 'reverted',
): Promise<string> {
  const proposed = await propose({
    repoId,
    agentId,
    statement,
    resourceKeys: [key],
    embedding: vector(seed),
  });
  if (proposed.decision !== 'granted') throw new Error(`expected a grant, got ${proposed.decision}`);

  await close({
    repoId,
    intentId: proposed.intentId,
    result,
    idempotencyKey: `idem-${seed}-${randomUUID()}`,
  });
  return proposed.intentId;
}

afterAll(async () => {
  await closePool();
});

describe('recall — semantic read with outcome history (§4.1)', () => {
  it('returns nothing for a repo with no findings', async () => {
    expect(await recall({ repoId: freshRepo(), embedding: vector(1) })).toEqual([]);
  });

  it('orders by distance and honours k', async () => {
    const repo = freshRepo();
    const query = vector(50);
    const near = paraphraseOf(query, 3, 0.018);
    const mid = paraphraseOf(query, 4, 0.055);
    // Guard the guard: both must sit inside the cutoff, near ahead of mid. Asserted against
    // DEFAULT_MAX_DISTANCE rather than a literal, so moving the constant cannot silently turn
    // this into a test of nothing — which is what happened when it read `< 0.35` and the
    // constant went to 0.60 (V34).
    expect(cosineDistance(query, near)).toBeLessThan(cosineDistance(query, mid));
    expect(cosineDistance(query, mid)).toBeLessThan(DEFAULT_MAX_DISTANCE);

    await insertFinding(repo, 'the limiter is keyed by account, not by IP', near);
    await insertFinding(repo, 'session expiry is enforced server side', mid);

    const all = await recall({ repoId: repo, embedding: query });
    expect(all.map((f) => f.fact)).toEqual([
      'the limiter is keyed by account, not by IP',
      'session expiry is enforced server side',
    ]);
    expect(all[0]!.distance).toBeLessThan(all[1]!.distance);
    expect(all[0]!.confidence).toBeCloseTo(0.5);

    const one = await recall({ repoId: repo, embedding: query, k: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.fact).toBe('the limiter is keyed by account, not by IP');
  });

  it('drops findings past the distance cutoff rather than padding the answer', async () => {
    const repo = freshRepo();
    const query = vector(51);
    // 0.2 of noise puts this at ~0.75, clear of the 0.60 cutoff with margin. It was 0.08
    // (~0.45) while the constant was 0.35; that value sits *inside* 0.60, so this test failed
    // loudly when the constant moved rather than passing on a vacuous premise. Keeping the
    // assertion relative to the constant is what made the failure informative.
    const far = paraphraseOf(query, 5, 0.2);
    expect(cosineDistance(query, far)).toBeGreaterThan(DEFAULT_MAX_DISTANCE);

    await insertFinding(repo, 'a fact about something else entirely', far);
    await insertFinding(repo, 'an orthogonal fact', vector(52));

    expect(await recall({ repoId: repo, embedding: query })).toEqual([]);
  });

  // §8 test 8. Not a formality: V5 in docs/verification-log.md showed the index
  // prefix fails open, so this test guards the only thing that actually isolates
  // tenants on the read path — the query's own repo filter.
  it('never returns a finding belonging to another repo', async () => {
    const repoA = freshRepo();
    const repoB = freshRepo();
    const shared = vector(60);

    await insertFinding(repoA, 'repo A knows this', shared);
    await insertFinding(repoB, 'repo B knows this', shared);

    const fromA = await recall({ repoId: repoA, embedding: shared });
    expect(fromA.map((f) => f.fact)).toEqual(['repo A knows this']);

    const fromB = await recall({ repoId: repoB, embedding: shared });
    expect(fromB.map((f) => f.fact)).toEqual(['repo B knows this']);
  });

  // §8 test 8 again, on the half the test above cannot see. That one proves the
  // `near` CTE is scoped; this one proves the LEFT JOIN behind it is too.
  //
  // `findings.source_intent_id` has no foreign key (sql/001_init.sql), so nothing
  // structural stops a finding in repo A from naming an intent in repo B. When it
  // does, the join reads that row and its revert history is counted into repo A's
  // ordering — the answer repo A receives is computed from a tenant it cannot see.
  // Invariant 5 is not "no other tenant's text is returned", it is that every read
  // carries the filter, precisely because reasoning about which rows happen to line
  // up is what fails open.
  it('never counts another repo\'s intent into this repo\'s history', async () => {
    const repoA = freshRepo();
    const repoB = freshRepo();
    const query = vector(90);

    const foreign = await closedIntent(
      repoB,
      'agent-b',
      'rewrite the settlement reconciler',
      'file:src/settle.ts',
      91,
      'reverted',
    );

    await insertFinding(repoA, 'repo A owns this fact', query, { sourceIntentId: foreign });

    const findings = await recall({ repoId: repoA, embedding: query });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.timesReverted).toBe(0);
    expect(findings[0]!.lastTouched).toBeNull();
  });

  // The claim worth putting on screen: a reverted history outranks raw similarity.
  it('surfaces a previously reverted finding ahead of a nearer clean one', async () => {
    const repo = freshRepo();
    const query = vector(70);
    const near = paraphraseOf(query, 6, 0.018);
    const mid = paraphraseOf(query, 7, 0.055);
    expect(cosineDistance(query, near)).toBeLessThan(cosineDistance(query, mid));

    const reverted = await closedIntent(
      repo,
      'agent-1',
      'ship the write-through cache',
      'file:src/cache.ts',
      71,
      'reverted',
    );

    await insertFinding(repo, 'the API client retries idempotent verbs only', near);
    await insertFinding(repo, 'the cache serves stale reads under concurrent writes', mid, {
      sourceIntentId: reverted,
    });

    const findings = await recall({ repoId: repo, embedding: query });
    expect(findings.map((f) => f.fact)).toEqual([
      'the cache serves stale reads under concurrent writes',
      'the API client retries idempotent verbs only',
    ]);
    expect(findings[0]!.timesReverted).toBe(1);
    expect(findings[0]!.lastTouched).toBeInstanceOf(Date);
    expect(findings[1]!.timesReverted).toBe(0);
    expect(findings[1]!.lastTouched).toBeNull();
  });

  it('does not count a clean close as a revert', async () => {
    const repo = freshRepo();
    const query = vector(80);
    const done = await closedIntent(
      repo,
      'agent-1',
      'add the health endpoint',
      'file:src/health.ts',
      81,
      'done',
    );

    await insertFinding(repo, 'the health endpoint is unauthenticated on purpose', query, {
      sourceIntentId: done,
    });

    const findings = await recall({ repoId: repo, embedding: query });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.timesReverted).toBe(0);
    expect(findings[0]!.lastTouched).toBeInstanceOf(Date);
  });
});
