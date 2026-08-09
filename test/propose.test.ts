/**
 * The arbitration transaction, against the cluster named by CORTEX_DSN.
 *
 * Covers invariants 1, 2, 3, 5 and 6 of spec/03-MEMORY-MODEL.md §8. Nothing is
 * mocked: every conflict here is two real SERIALIZABLE transactions contending
 * for the same primary key, because a simulated conflict would only prove that
 * the test can construct the result it expects.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool';
import { canonicalKey, expandKeys, ResourceKeyError } from '../src/memory/keys';
import { propose } from '../src/memory/propose';
import { cosineDistance, paraphraseOf, vector } from './helpers/vectors';

/** A fresh repo per test. repo_id is the tenant boundary, so tests never share one. */
function freshRepo(): string {
  return randomUUID();
}

async function claimsFor(repoId: string): Promise<Array<{ key: string; holder: string }>> {
  const { rows } = await getPool().query(
    'SELECT resource_key, holder FROM claims WHERE repo_id = $1 ORDER BY resource_key',
    [repoId],
  );
  return rows.map((r) => ({ key: r.resource_key as string, holder: r.holder as string }));
}

async function intentCount(repoId: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT count(*) AS n FROM intents WHERE repo_id = $1',
    [repoId],
  );
  return Number((rows[0] as { n: string }).n);
}

afterAll(async () => {
  await closePool();
});

describe('resource key grammar (§3)', () => {
  it('canonicalises separators, leading ./ and scheme case', () => {
    expect(canonicalKey('FILE:./src\\auth\\login.ts')).toBe('file:src/auth/login.ts');
    expect(canonicalKey('  file:src//auth/login.ts  ')).toBe('file:src/auth/login.ts');
    expect(canonicalKey('glob:src/auth/**/')).toBe('glob:src/auth/**');
  });

  it('keeps path case, because a case-sensitive checkout has both files', () => {
    expect(canonicalKey('file:src/Auth.ts')).not.toBe(canonicalKey('file:src/auth.ts'));
  });

  it('rejects keys that escape the repo or name no scheme', () => {
    expect(() => canonicalKey('file:../../etc/passwd')).toThrow(ResourceKeyError);
    expect(() => canonicalKey('file:/etc/passwd')).toThrow(ResourceKeyError);
    expect(() => canonicalKey('src/auth/login.ts')).toThrow(ResourceKeyError);
    expect(() => canonicalKey('ftp:whatever')).toThrow(ResourceKeyError);
  });

  it('expands a glob to its files plus the glob itself, sorted and deduped', async () => {
    const keys = await expandKeys(['glob:src/auth/**', 'file:src/auth/login.ts'], () => [
      'src/auth/login.ts',
      'src/auth/session.ts',
    ]);
    expect(keys).toEqual([
      'file:src/auth/login.ts',
      'file:src/auth/session.ts',
      'glob:src/auth/**',
    ]);
  });

  it('refuses an expansion over the 200-key limit rather than widening it', async () => {
    const many = Array.from({ length: 201 }, (_, i) => `src/f${i}.ts`);
    await expect(expandKeys(['glob:src/**'], () => many)).rejects.toThrow(/over the 200/);
  });
});

describe('propose — arbitration (§4.2)', () => {
  it('grants an uncontested claim and writes one row per key', async () => {
    const repo = freshRepo();
    const result = await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'add rate limiting to the login route',
      resourceKeys: ['file:src/auth/login.ts', 'file:src/auth/limiter.ts'],
      embedding: vector(1),
    });

    expect(result.decision).toBe('granted');
    if (result.decision !== 'granted') return;
    expect(result.keys).toHaveLength(2);
    expect(await claimsFor(repo)).toEqual([
      { key: 'file:src/auth/limiter.ts', holder: 'agent-1' },
      { key: 'file:src/auth/login.ts', holder: 'agent-1' },
    ]);
  });

  // §8 test 1 + §4.2 invariant 3
  it('blocks the second agent and tells it who holds the key', async () => {
    const repo = freshRepo();
    const first = await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'rewrite the login route',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(1),
    });
    expect(first.decision).toBe('granted');

    const second = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'something entirely unrelated to the first statement',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(999),
    });

    expect(second.decision).toBe('blocked');
    if (second.decision !== 'blocked') return;
    expect(second.contested).toHaveLength(1);
    expect(second.contested[0]!.holder).toBe('agent-1');
    // The loser can reach the winner's intent, not just its name.
    if (first.decision === 'granted') {
      expect(second.contested[0]!.intentId).toBe(first.intentId);
    }
  });

  // §8 test 2 + §4.2 invariant 1
  it('leaves no partial claim set when one key of several is contested', async () => {
    const repo = freshRepo();
    await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'touch the shared file',
      resourceKeys: ['file:src/shared.ts'],
      embedding: vector(1),
    });

    const blocked = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'a different piece of work that happens to overlap',
      resourceKeys: ['file:src/a.ts', 'file:src/shared.ts', 'file:src/b.ts'],
      embedding: vector(999),
    });

    expect(blocked.decision).toBe('blocked');
    // agent-2 must hold nothing at all — not the two keys it could have had.
    expect(await claimsFor(repo)).toEqual([{ key: 'file:src/shared.ts', holder: 'agent-1' }]);
  });

  // §8 test 3 — the overlap ON CONFLICT cannot express
  it('detects glob versus file overlap in both directions', async () => {
    const globFirst = freshRepo();
    await propose({
      repoId: globFirst,
      agentId: 'agent-1',
      statement: 'refactor the whole auth directory',
      resourceKeys: ['glob:src/auth/**'],
      embedding: vector(1),
      resolveGlob: () => ['src/auth/login.ts', 'src/auth/session.ts'],
    });
    const fileBlocked = await propose({
      repoId: globFirst,
      agentId: 'agent-2',
      statement: 'unrelated work on one auth file',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(999),
    });
    expect(fileBlocked.decision).toBe('blocked');

    const fileFirst = freshRepo();
    await propose({
      repoId: fileFirst,
      agentId: 'agent-1',
      statement: 'patch one auth file',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(1),
    });
    const globBlocked = await propose({
      repoId: fileFirst,
      agentId: 'agent-2',
      statement: 'unrelated sweeping refactor of auth',
      resourceKeys: ['glob:src/auth/**'],
      embedding: vector(999),
      resolveGlob: () => ['src/auth/login.ts', 'src/auth/session.ts'],
    });
    expect(globBlocked.decision).toBe('blocked');
  });

  // §8 test 6 + §4.2 invariant 4
  it('dedupes a paraphrase of an in-flight intent and returns its holder', async () => {
    const repo = freshRepo();
    const base = vector(42);
    const paraphrase = paraphraseOf(base, 7);
    // Guard the guard: the pair must actually be inside the threshold, or this
    // test would pass for the wrong reason.
    expect(cosineDistance(base, paraphrase)).toBeLessThan(0.28);

    const first = await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'add rate limiting to the login route',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: base,
    });
    expect(first.decision).toBe('granted');

    const second = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'throttle repeated login attempts',
      resourceKeys: ['file:src/auth/other.ts'],
      embedding: paraphrase,
    });

    expect(second.decision).toBe('deduped');
    if (second.decision !== 'deduped') return;
    expect(second.holder).toBe('agent-1');
    expect(second.status).toBe('in_flight');
    if (first.decision === 'granted') expect(second.of).toBe(first.intentId);
  });

  // §4.2 invariant 2 — dedupe and claim share one snapshot, so a dedupe leaves
  // nothing behind. A read-then-write across two transactions would have written
  // the intent before discovering the duplicate.
  it('writes no intent and no claim when it dedupes', async () => {
    const repo = freshRepo();
    const base = vector(42);
    await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'add rate limiting',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: base,
    });

    expect(await intentCount(repo)).toBe(1);
    await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'throttle repeated logins',
      resourceKeys: ['file:src/auth/other.ts'],
      embedding: paraphraseOf(base, 7),
    });

    expect(await intentCount(repo)).toBe(1);
    expect(await claimsFor(repo)).toEqual([
      { key: 'file:src/auth/login.ts', holder: 'agent-1' },
    ]);
  });

  it('does not dedupe against an unrelated intent in the same repo', async () => {
    const repo = freshRepo();
    await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'add rate limiting',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(1),
    });

    const second = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'rewrite the billing exporter',
      resourceKeys: ['file:src/billing/export.ts'],
      embedding: vector(2),
    });

    expect(second.decision).toBe('granted');
  });

  // §8 test 8 — isolation lives in the index prefix, not a WHERE clause
  it('never dedupes against an identical intent in a different repo', async () => {
    const shared = vector(77);
    const repoA = freshRepo();
    const repoB = freshRepo();

    await propose({
      repoId: repoA,
      agentId: 'agent-1',
      statement: 'add rate limiting',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: shared,
    });

    const inB = await propose({
      repoId: repoB,
      agentId: 'agent-2',
      statement: 'add rate limiting',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: shared,
    });

    // Same statement, same embedding, same key — different tenant, so it stands.
    expect(inB.decision).toBe('granted');
  });

  // §8 test 5
  it('reclaims an expired claim without waiting for the TTL sweep', async () => {
    const repo = freshRepo();
    const first = await propose({
      repoId: repo,
      agentId: 'agent-1',
      statement: 'a short-lived piece of work',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(1),
      leaseSeconds: 1,
    });
    expect(first.decision).toBe('granted');

    // Held while the lease is live.
    const tooSoon = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'unrelated work on the same file',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(999),
    });
    expect(tooSoon.decision).toBe('blocked');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The row is almost certainly still present — V4 measured the sweep landing
    // 62-221s behind expires_at — so this proves acquisition reads the lease
    // rather than waiting for the row to disappear.
    const afterExpiry = await propose({
      repoId: repo,
      agentId: 'agent-3',
      statement: 'work that arrives after the lease lapsed',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(998),
    });

    expect(afterExpiry.decision).toBe('granted');
    expect(await claimsFor(repo)).toEqual([
      { key: 'file:src/auth/login.ts', holder: 'agent-3' },
    ]);
  });

  // §8 test 1, under genuine concurrency
  it('lets exactly one of two simultaneous agents win the same key', async () => {
    const repo = freshRepo();
    const results = await Promise.all([
      propose({
        repoId: repo,
        agentId: 'agent-1',
        statement: 'first agent take on the migration',
        resourceKeys: ['migration:0042'],
        embedding: vector(11),
      }),
      propose({
        repoId: repo,
        agentId: 'agent-2',
        statement: 'a completely different approach to something else',
        resourceKeys: ['migration:0042'],
        embedding: vector(22),
      }),
    ]);

    const granted = results.filter((r) => r.decision === 'granted');
    const blocked = results.filter((r) => r.decision === 'blocked');
    expect(granted).toHaveLength(1);
    expect(blocked).toHaveLength(1);

    const holder = (await claimsFor(repo))[0]!.holder;
    const loser = blocked[0]!;
    if (loser.decision === 'blocked') {
      expect(loser.contested[0]!.holder).toBe(holder);
    }
  });
});
