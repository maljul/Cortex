/**
 * U9 — `cortex_close` over the MCP write plane, against the real cluster.
 *
 * `docs/UNITS.md` U9, narrowed by the 2026-08-09 decision that lease extension is
 * cut: "a granted intent can be closed exactly once through the tool surface."
 * *Exactly once* is the whole unit, so most of what is here is the second call.
 *
 * Every test drives `scripts/serve-mcp.mts` as a child process over pipes, and the
 * intents being closed were granted through `cortex_propose` on that same wire —
 * closing an intent a test inserted itself would prove the handler runs against
 * rows of the test's own shape rather than against the ones the surface produces.
 *
 * Invariants at risk, per `spec/03-MEMORY-MODEL.md` §8:
 *
 * - **Exactly once**, which is `03` §4.3's `UNIQUE (repo_id, idempotency_key)`. A
 *   redelivered tool call must be a no-op that reports itself, and a genuinely
 *   second close must fail without leaving a ledger row behind it.
 * - **5** — every read carries `WHERE repo_id`. `cortex_close` is the second surface
 *   to derive a tenant from a slug, and the first that must refuse to *create* one.
 * - **7** — nothing structural crosses the boundary; the enum, the two bounds and
 *   the required list are all enforced, not merely published.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const created: string[] = [];

function freshSlug(label: string): string {
  const slug = `cortex-test/u9-${label}-${randomUUID()}`;
  created.push(slug);
  return slug;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

let client: Client;

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function textOf(result: ToolResult): string {
  const text = result.content?.[0]?.text;
  expect(text, 'the tool returned text content').toBeTypeOf('string');
  return text!;
}

/** Calls a tool that is expected to succeed and returns its parsed payload. */
async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool(name, args);
  expect(result.isError, `${name} reported an error: ${textOf(result)}`).toBeFalsy();
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** Grants an intent the honest way, through the tool surface, and returns its id. */
async function grant(slug: string, statement: string, keys: string[]): Promise<string> {
  const decision = await ok('cortex_propose', {
    repo: slug,
    agent_id: 'agent-1',
    statement,
    resource_keys: keys,
  });
  expect(decision.decision).toBe('granted');
  return decision.intentId as string;
}

async function repoIdOf(slug: string): Promise<string> {
  const { rows } = await getPool().query('SELECT id FROM repos WHERE slug = $1', [slug]);
  expect(rows.length, `repos row for ${slug}`).toBe(1);
  return (rows[0] as { id: string }).id;
}

async function countOf(table: 'claims' | 'action_ledger', repoId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(*) AS n FROM ${table} WHERE repo_id = $1`,
    [repoId],
  );
  return Number((rows[0] as { n: string }).n);
}

beforeAll(async () => {
  client = new Client({ name: 'cortex-u9-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'scripts/serve-mcp.mts'],
      cwd: repoRoot,
      stderr: 'pipe',
    }),
  );
});

afterAll(async () => {
  await client.close();

  const pool = getPool();
  const { rows } = await pool.query('SELECT id FROM repos WHERE slug = ANY($1::STRING[])', [
    created,
  ]);
  for (const { id } of rows as Array<{ id: string }>) {
    await pool.query('DELETE FROM claims WHERE repo_id = $1', [id]);
    await pool.query('DELETE FROM action_ledger WHERE repo_id = $1', [id]);
    await pool.query('DELETE FROM intents WHERE repo_id = $1', [id]);
  }
  await pool.query('DELETE FROM repos WHERE slug = ANY($1::STRING[])', [created]);

  await closePool();
});

describe('cortex_close over stdio', () => {
  it('closes a granted intent, records the outcome and releases every claim', async () => {
    const slug = freshSlug('close');
    const keys = ['file:src/a.ts', 'file:src/b.ts'];
    const intentId = await grant(slug, 'Add rate limiting to the login endpoint', keys);

    const closed = await ok('cortex_close', {
      repo: slug,
      intent_id: intentId,
      result: 'done',
      files_changed: keys,
      notes: 'Token bucket, 100 requests per minute, keyed on the account id.',
      tokens_spent: 4200,
      idempotency_key: `close-${intentId}`,
    });

    expect(closed).toMatchObject({ applied: true, intentId, status: 'done', releasedKeys: 2 });

    const repoId = await repoIdOf(slug);
    expect(await countOf('claims', repoId), 'claims released').toBe(0);
    expect(await countOf('action_ledger', repoId), 'one ledger row').toBe(1);

    const { rows } = await getPool().query(
      'SELECT status, outcome, tokens_spent FROM intents WHERE id = $1 AND repo_id = $2',
      [intentId, repoId],
    );
    expect(rows[0]).toMatchObject({
      status: 'done',
      tokens_spent: '4200',
      outcome: {
        result: 'done',
        files_changed: keys,
        notes: 'Token bucket, 100 requests per minute, keyed on the account id.',
      },
    });
  });

  it('treats a redelivered call as a no-op that says so — exactly once', async () => {
    const slug = freshSlug('redeliver');
    const intentId = await grant(slug, 'Add rate limiting to the login endpoint', [
      'file:src/a.ts',
    ]);
    const args = {
      repo: slug,
      intent_id: intentId,
      result: 'done',
      idempotency_key: `close-${intentId}`,
    };

    const first = await ok('cortex_close', args);
    expect(first).toMatchObject({ applied: true, releasedKeys: 1 });

    // The same call again, byte for byte, as a dropped response would produce.
    // It must not error — an agent that sees an error here closes again, or worse
    // decides its work never landed — and it must not release a second time.
    const second = await ok('cortex_close', args);
    expect(second).toMatchObject({ applied: false, intentId, status: 'done', releasedKeys: 0 });

    expect(await countOf('action_ledger', await repoIdOf(slug)), 'still one ledger row').toBe(1);
  });

  it('refuses a genuine second close, and leaves no ledger row when it does', async () => {
    const slug = freshSlug('twice');
    const intentId = await grant(slug, 'Add rate limiting to the login endpoint', [
      'file:src/a.ts',
    ]);

    await ok('cortex_close', {
      repo: slug,
      intent_id: intentId,
      result: 'done',
      idempotency_key: `close-${intentId}`,
    });

    // A new key, so this is not a redelivery: it is a caller that lost track of its
    // own work. `03` §4.3 puts the ledger insert first precisely so the rollback
    // takes the ledger row with it.
    const again = await callTool('cortex_close', {
      repo: slug,
      intent_id: intentId,
      result: 'done',
      idempotency_key: `close-${intentId}-again`,
    });

    expect(again.isError, 'a second close is an error').toBe(true);
    expect(textOf(again)).toMatch(/already done/i);
    expect(await countOf('action_ledger', await repoIdOf(slug)), 'no orphan ledger row').toBe(1);
  });

  it('records a revert as done, because a revert is work that completed', async () => {
    // `intents.status` admits no 'reverted', and §4.1's times_reverted counts
    // reverts off the outcome. Mapping it to 'abandoned' would zero that column.
    const slug = freshSlug('revert');
    const intentId = await grant(slug, 'Add rate limiting to the login endpoint', [
      'file:src/a.ts',
    ]);

    const closed = await ok('cortex_close', {
      repo: slug,
      intent_id: intentId,
      result: 'reverted',
      idempotency_key: `close-${intentId}`,
    });
    expect(closed.status).toBe('done');

    const { rows } = await getPool().query(
      'SELECT status, outcome FROM intents WHERE id = $1 AND repo_id = $2',
      [intentId, await repoIdOf(slug)],
    );
    expect(rows[0]).toMatchObject({ status: 'done', outcome: { result: 'reverted' } });
  });
});

describe('invariant 5 — cortex_close derives a tenant but never creates one', () => {
  it('refuses an unregistered repo instead of registering it', async () => {
    // propose registers on first sight; close must not. A close never legitimately
    // precedes a propose, so an unknown slug is a typo — and registering it would
    // mint a tenant and then answer "no such intent here", which sends the caller
    // looking for the wrong bug.
    const slug = freshSlug('unregistered');

    const refused = await callTool('cortex_close', {
      repo: slug,
      intent_id: randomUUID(),
      result: 'done',
      idempotency_key: 'k1',
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/repo/i);

    const { rows } = await getPool().query('SELECT count(*) AS n FROM repos WHERE slug = $1', [
      slug,
    ]);
    expect(Number((rows[0] as { n: string }).n), 'no tenant was minted').toBe(0);
  });

  it('cannot close another tenant’s intent', async () => {
    const a = freshSlug('owner');
    const b = freshSlug('stranger');
    const intentId = await grant(a, 'Add rate limiting to the login endpoint', ['file:src/a.ts']);
    // Register b so the refusal below is about the intent, not about the slug.
    await grant(b, 'Translate the German onboarding documentation into Polish', [
      'file:src/z.ts',
    ]);

    const refused = await callTool('cortex_close', {
      repo: b,
      intent_id: intentId,
      result: 'done',
      idempotency_key: 'k1',
    });
    expect(refused.isError).toBe(true);

    const { rows } = await getPool().query('SELECT status FROM intents WHERE id = $1', [intentId]);
    expect(rows[0], "the owner's intent is untouched").toMatchObject({ status: 'in_flight' });
  });
});

describe('invariant 7 — cortex_close enforces the schema it publishes', () => {
  async function refuses(args: Record<string, unknown>, pattern: RegExp): Promise<void> {
    await expect(
      client.callTool({ name: 'cortex_close', arguments: args }),
      `should refuse ${JSON.stringify(args)}`,
    ).rejects.toThrow(pattern);
  }

  const valid = {
    repo: 'cortex-test/u9-never-reached',
    intent_id: randomUUID(),
    result: 'done',
    idempotency_key: 'k1',
  };

  it('refuses a call missing a required argument', async () => {
    const { idempotency_key: _omitted, ...withoutKey } = valid;
    await refuses(withoutKey, /idempotency_key/i);
  });

  it('refuses a result outside the published enum', async () => {
    await refuses({ ...valid, result: 'finished' }, /done, abandoned, reverted/);
  });

  it('enforces the notes bound and the tokens_spent type', async () => {
    await refuses({ ...valid, notes: 'x'.repeat(2001) }, /2000/);
    await refuses({ ...valid, tokens_spent: 'lots' }, /integer/i);
    await refuses({ ...valid, files_changed: [1, 2] }, /files_changed/);
  });

  it('refuses an undeclared argument', async () => {
    await refuses({ ...valid, table: 'claims' }, /undeclared argument/i);
  });
});
