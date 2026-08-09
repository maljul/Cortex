/**
 * CLOSE — outcome, ledger and release in one transaction, against the cluster
 * named by CORTEX_DSN. spec/03-MEMORY-MODEL.md §4.3.
 *
 * Covers invariant 4 of §8: a retried close with the same idempotency key applies
 * the effect once. The retry is also exercised under genuine concurrency, because
 * the interesting failure is two deliveries of the same tool call racing, not two
 * sequential calls.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import { close, CloseError } from '../src/memory/close.js';
import { propose } from '../src/memory/propose.js';
import { vector } from './helpers/vectors.js';

function freshRepo(): string {
  return randomUUID();
}

/** Proposes and asserts the grant, so each test starts from a held claim. */
async function granted(
  repoId: string,
  agentId: string,
  statement: string,
  resourceKeys: string[],
  seed: number,
): Promise<string> {
  const result = await propose({ repoId, agentId, statement, resourceKeys, embedding: vector(seed) });
  if (result.decision !== 'granted') {
    throw new Error(`expected a grant, got ${result.decision}`);
  }
  return result.intentId;
}

async function ledgerRows(
  repoId: string,
): Promise<Array<{ intentId: string; idempotencyKey: string; action: string; digest: string }>> {
  const { rows } = await getPool().query(
    `SELECT intent_id, idempotency_key, action, payload_digest
       FROM action_ledger WHERE repo_id = $1 ORDER BY applied_at`,
    [repoId],
  );
  return rows.map((r) => ({
    intentId: r.intent_id as string,
    idempotencyKey: r.idempotency_key as string,
    action: r.action as string,
    digest: r.payload_digest as string,
  }));
}

async function intentRow(
  intentId: string,
): Promise<{ status: string; outcome: Record<string, unknown> | null; tokens: number; closedAt: Date | null }> {
  const { rows } = await getPool().query(
    'SELECT status, outcome, tokens_spent, closed_at FROM intents WHERE id = $1',
    [intentId],
  );
  const row = rows[0] as
    | { status: string; outcome: Record<string, unknown> | null; tokens_spent: string; closed_at: Date | null }
    | undefined;
  if (!row) throw new Error(`no intent ${intentId}`);
  return {
    status: row.status,
    outcome: row.outcome,
    tokens: Number(row.tokens_spent),
    closedAt: row.closed_at,
  };
}

async function claimCount(repoId: string): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT count(*) AS n FROM claims WHERE repo_id = $1',
    [repoId],
  );
  return Number((rows[0] as { n: string }).n);
}

afterAll(async () => {
  await closePool();
});

describe('close — outcome, ledger and release (§4.3)', () => {
  it('records the outcome, writes one ledger row and releases every claim', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'add rate limiting to login', [
      'file:src/auth/login.ts',
      'file:src/auth/limiter.ts',
    ], 1);

    const result = await close({
      repoId: repo,
      intentId,
      result: 'done',
      idempotencyKey: 'idem-1',
      filesChanged: ['src/auth/login.ts'],
      notes: 'the limiter is keyed by account, not by IP; a NAT would lock out a whole office',
      tokensSpent: 4200,
    });

    expect(result.applied).toBe(true);
    expect(result.status).toBe('done');
    expect(result.releasedKeys).toBe(2);

    const intent = await intentRow(intentId);
    expect(intent.status).toBe('done');
    expect(intent.tokens).toBe(4200);
    expect(intent.closedAt).not.toBeNull();
    expect(intent.outcome).toMatchObject({
      result: 'done',
      files_changed: ['src/auth/login.ts'],
    });

    expect(await claimCount(repo)).toBe(0);
    expect(await ledgerRows(repo)).toHaveLength(1);
  });

  // §8 test 4 — the invariant this file exists for
  it('applies once when the same idempotency key is delivered twice', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'rewrite the session store', [
      'file:src/auth/session.ts',
    ], 2);

    const first = await close({
      repoId: repo,
      intentId,
      result: 'done',
      idempotencyKey: 'idem-retry',
      notes: 'sessions now expire on the server, not only in the cookie',
      tokensSpent: 100,
    });
    const closedAt = (await intentRow(intentId)).closedAt;

    const second = await close({
      repoId: repo,
      intentId,
      result: 'done',
      idempotencyKey: 'idem-retry',
      notes: 'sessions now expire on the server, not only in the cookie',
      tokensSpent: 100,
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.status).toBe('done');
    expect(second.releasedKeys).toBe(0);

    // Exactly one effect: one ledger row, and the close instant never moved.
    expect(await ledgerRows(repo)).toHaveLength(1);
    expect((await intentRow(intentId)).closedAt).toEqual(closedAt);
  });

  // §8 test 4, under genuine concurrency — two deliveries of one tool call
  it('applies once when the same idempotency key arrives twice at the same moment', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'migrate the accounts table', [
      'migration:0042',
    ], 3);

    const both = await Promise.all([
      close({ repoId: repo, intentId, result: 'done', idempotencyKey: 'idem-race', tokensSpent: 7 }),
      close({ repoId: repo, intentId, result: 'done', idempotencyKey: 'idem-race', tokensSpent: 7 }),
    ]);

    expect(both.filter((r) => r.applied)).toHaveLength(1);
    expect(await ledgerRows(repo)).toHaveLength(1);
    expect(await claimCount(repo)).toBe(0);
  });

  it('frees the key immediately, without waiting for the TTL sweep', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'patch the login route', [
      'file:src/auth/login.ts',
    ], 4);

    const blocked = await propose({
      repoId: repo,
      agentId: 'agent-2',
      statement: 'entirely unrelated work that happens to touch the same file',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(901),
    });
    expect(blocked.decision).toBe('blocked');

    await close({ repoId: repo, intentId, result: 'done', idempotencyKey: 'idem-free' });

    const afterClose = await propose({
      repoId: repo,
      agentId: 'agent-3',
      statement: 'a third piece of work with nothing in common with the others',
      resourceKeys: ['file:src/auth/login.ts'],
      embedding: vector(902),
    });
    expect(afterClose.decision).toBe('granted');
  });

  it('closes an abandoned intent without pretending it succeeded', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'try the risky refactor', ['file:src/x.ts'], 5);

    const result = await close({
      repoId: repo,
      intentId,
      result: 'abandoned',
      idempotencyKey: 'idem-abandon',
      notes: 'the test suite depends on the old signature in eleven places; not worth it',
    });

    expect(result.status).toBe('abandoned');
    expect((await intentRow(intentId)).status).toBe('abandoned');
    expect(await claimCount(repo)).toBe(0);
  });

  // The status enum has no 'reverted'; the outcome does. See close.ts for why.
  it('stores a reverted result as a closed intent carrying the revert in its outcome', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'ship the cache layer', ['file:src/cache.ts'], 6);

    const result = await close({
      repoId: repo,
      intentId,
      result: 'reverted',
      idempotencyKey: 'idem-revert',
      notes: 'the cache served stale reads under concurrent writes; rolled back in 3f21a0c',
    });

    expect(result.status).toBe('done');
    const intent = await intentRow(intentId);
    expect(intent.status).toBe('done');
    expect(intent.outcome).toMatchObject({ result: 'reverted' });
  });

  it('rejects a close for an intent that does not exist', async () => {
    await expect(
      close({
        repoId: freshRepo(),
        intentId: randomUUID(),
        result: 'done',
        idempotencyKey: 'idem-missing',
      }),
    ).rejects.toThrow(CloseError);
  });

  it('rejects a close aimed at the wrong repo, and leaves the claims held', async () => {
    const repoA = freshRepo();
    const repoB = freshRepo();
    const intentId = await granted(repoA, 'agent-1', 'work belonging to repo A', [
      'file:src/a.ts',
    ], 7);

    await expect(
      close({ repoId: repoB, intentId, result: 'done', idempotencyKey: 'idem-wrong-repo' }),
    ).rejects.toThrow(CloseError);

    expect(await claimCount(repoA)).toBe(1);
    expect(await ledgerRows(repoB)).toHaveLength(0);
  });

  // Invariant 5 — every read carries WHERE repo_id. The test above proves the close
  // is refused; it does not prove *how*, and a refusal computed from an unfiltered
  // read of `intents` satisfies it just as well. The observable difference is what
  // repo B is told: if the message distinguishes "another repo holds this id" from
  // "no such id", it is an existence oracle over another tenant's primary keys, and
  // the read that produced it left the repo.
  it('tells repo B nothing about repo A\'s intent it could not learn from a random id', async () => {
    const repoA = freshRepo();
    const repoB = freshRepo();
    const held = await granted(repoA, 'agent-1', 'work belonging to repo A', [
      'file:src/leak.ts',
    ], 21);
    const absent = randomUUID();

    const caught = async (intentId: string, key: string): Promise<Error> => {
      try {
        await close({ repoId: repoB, intentId, result: 'done', idempotencyKey: key });
      } catch (error) {
        return error as Error;
      }
      throw new Error(`close of ${intentId} from repo B was not refused`);
    };

    const crossTenant = await caught(held, 'idem-cross-tenant');
    const nonexistent = await caught(absent, 'idem-nonexistent');

    expect(crossTenant).toBeInstanceOf(CloseError);
    expect(nonexistent).toBeInstanceOf(CloseError);
    expect(crossTenant.message).not.toMatch(/another repo/i);

    // Identical once the id itself is masked: repo B learns only that the id is not
    // one of its own, which is what it already knew.
    expect(crossTenant.message.replace(held, '<id>')).toBe(
      nonexistent.message.replace(absent, '<id>'),
    );

    // And nothing was disturbed on either side of the boundary.
    expect(await claimCount(repoA)).toBe(1);
    expect(await ledgerRows(repoB)).toHaveLength(0);
  });

  it('rejects a second close under a different idempotency key', async () => {
    const repo = freshRepo();
    const intentId = await granted(repo, 'agent-1', 'close me once', ['file:src/once.ts'], 8);
    await close({ repoId: repo, intentId, result: 'done', idempotencyKey: 'idem-first' });

    // Not a retry — a second close. §5 of 05-INTERFACES.md: exactly once per intent.
    await expect(
      close({ repoId: repo, intentId, result: 'abandoned', idempotencyKey: 'idem-second' }),
    ).rejects.toThrow(CloseError);

    expect((await intentRow(intentId)).status).toBe('done');
  });

  it('rejects an idempotency key already spent by a different intent', async () => {
    const repo = freshRepo();
    const one = await granted(repo, 'agent-1', 'the first task', ['file:src/one.ts'], 9);
    const two = await granted(repo, 'agent-2', 'a completely separate second task', [
      'file:src/two.ts',
    ], 10);

    await close({ repoId: repo, intentId: one, result: 'done', idempotencyKey: 'idem-shared' });

    // Silently treating this as a retry would drop a real close on the floor.
    await expect(
      close({ repoId: repo, intentId: two, result: 'done', idempotencyKey: 'idem-shared' }),
    ).rejects.toThrow(CloseError);

    expect((await intentRow(two)).status).toBe('in_flight');
  });
});
