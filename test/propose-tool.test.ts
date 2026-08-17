/**
 * U8 — `cortex_propose` over the MCP write plane, against the real cluster.
 *
 * `docs/UNITS.md` U8 is done when "a real coding agent attaches and successfully
 * proposes". No test can assert the *agent*; what it can assert is everything
 * between the wire and the rows, so every test here spawns
 * `scripts/serve-mcp.mts` as a child process and speaks MCP to it over pipes,
 * exactly as U7 does. Nothing is stubbed: the statements are embedded by Titan on
 * the live endpoint and the decisions come out of the arbitration transaction in
 * `src/memory/propose.ts`.
 *
 * Invariants at risk, per `spec/03-MEMORY-MODEL.md` §8:
 *
 * - **1** — dedupe and claim share one transaction. The way this unit breaks it is
 *   not by editing `propose.ts` but by the MCP layer growing its own SQL. Two
 *   concurrent tool calls contending for one key must still produce exactly one
 *   winner and exactly one claim row.
 * - **3 and 4** — and the unit's named silent break: `blocked` and `deduped` are
 *   return values. If either arrives as a tool error, an agent retries through a
 *   block and the fleet becomes the queue `03` §5 forbids.
 * - **5** — every read carries `WHERE repo_id`. U8 adds the first code that *derives*
 *   a `repo_id` rather than being handed one, so a slug that resolves loosely is a
 *   new way to cross a tenant boundary.
 * - **6** — every write path wrapped in the 40001 retry helper. The slug row is a
 *   write, and it is the one every agent in a fleet touches at once.
 * - **7** — nothing structural crosses the tool boundary. U7 closed the surface
 *   against undeclared arguments with no handler behind it; now there is one.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import { resolveRepoId } from '../src/memory/repos.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Two statements far enough apart that Titan cannot put them inside the 0.28
 * dedupe threshold. Contention tests need a genuine block, and two paraphrases of
 * one task would dedupe instead — which is correct behaviour, and a different test.
 */
const UNRELATED = {
  a: 'Add rate limiting to the login endpoint',
  b: 'Translate the German onboarding documentation into Polish',
};

/** Slugs created by this file, torn down at the end so `repos` does not accumulate. */
const created: string[] = [];

function freshSlug(label: string): string {
  const slug = `cortex-test/u8-${label}-${randomUUID()}`;
  created.push(slug);
  return slug;
}

interface ToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

let client: Client;

/** Calls the tool and returns the decision it produced, or throws what it threw. */
async function propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({
    name: 'cortex_propose',
    arguments: args,
  })) as ToolResult;

  // The named silent break for this unit. `blocked` and `deduped` reaching an agent
  // as errors is indistinguishable, from the agent's side, from the cluster being
  // down — and the documented reaction to an error is to retry.
  expect(result.isError, `propose reported an error: ${JSON.stringify(result.content)}`).toBeFalsy();

  const text = result.content?.[0]?.text;
  expect(text, 'propose returned text content').toBeTypeOf('string');
  return JSON.parse(text!) as Record<string, unknown>;
}

async function repoIdOf(slug: string): Promise<string> {
  const { rows } = await getPool().query('SELECT id FROM repos WHERE slug = $1', [slug]);
  expect(rows.length, `repos row for ${slug}`).toBe(1);
  return (rows[0] as { id: string }).id;
}

async function claimsFor(repoId: string): Promise<Array<{ key: string; holder: string }>> {
  const { rows } = await getPool().query(
    'SELECT resource_key, holder FROM claims WHERE repo_id = $1 ORDER BY resource_key',
    [repoId],
  );
  return rows.map((r) => ({ key: r.resource_key as string, holder: r.holder as string }));
}

beforeAll(async () => {
  client = new Client({ name: 'cortex-u8-test', version: '0.0.0' });
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
    await pool.query('DELETE FROM intents WHERE repo_id = $1', [id]);
  }
  await pool.query('DELETE FROM repos WHERE slug = ANY($1::STRING[])', [created]);

  await closePool();
});

describe('slug to repo_id (`05` §6 CORTEX_REPO, `03` §2 repos.slug)', () => {
  it('is idempotent, and concurrent first calls agree on one id', async () => {
    // Invariant 6 in the place it actually bites: a fleet attaching at once writes
    // this row simultaneously. Six concurrent inserts on a UNIQUE column is a
    // 40001 generator, and an unretried write path surfaces it as a failed propose.
    const slug = freshSlug('resolve');

    const ids = await Promise.all(Array.from({ length: 6 }, () => resolveRepoId(slug)));

    expect(new Set(ids).size, `six calls, ids: ${[...new Set(ids)].join(', ')}`).toBe(1);
    const { rows } = await getPool().query('SELECT count(*) AS n FROM repos WHERE slug = $1', [
      slug,
    ]);
    expect(Number((rows[0] as { n: string }).n)).toBe(1);
  });

  it('folds case, because one repo with two spellings is no mutual exclusion at all', async () => {
    // Two agents on the same checkout whose remotes differ only in case would
    // otherwise land in two tenants and never see each other's claims — a silent
    // double-grant with no error anywhere.
    const slug = freshSlug('case');
    expect(await resolveRepoId(slug.toUpperCase())).toBe(await resolveRepoId(slug));
  });

  it('matches a slug exactly — a prefix is a different tenant', async () => {
    const slug = freshSlug('prefix');
    created.push(`${slug}-extra`);
    expect(await resolveRepoId(`${slug}-extra`)).not.toBe(await resolveRepoId(slug));
  });
});

describe('cortex_propose over stdio', () => {
  it('grants an uncontested claim and writes the rows to the cluster', async () => {
    const slug = freshSlug('grant');

    const decision = await propose({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: ['file:src/auth/login.ts', 'file:src/auth/session.ts'],
    });

    expect(decision.decision).toBe('granted');
    expect(decision.intentId).toBeTypeOf('string');
    expect(decision.keys).toEqual(['file:src/auth/login.ts', 'file:src/auth/session.ts']);
    // `05` §1 types expiresAt as a string on the decision an agent receives.
    expect(Date.parse(decision.expiresAt as string)).toBeGreaterThan(Date.now());

    // Over the wire is half of it; the other half is that the write happened.
    const repoId = await repoIdOf(slug);
    expect(await claimsFor(repoId)).toEqual([
      { key: 'file:src/auth/login.ts', holder: 'agent-1' },
      { key: 'file:src/auth/session.ts', holder: 'agent-1' },
    ]);

    const { rows } = await getPool().query(
      'SELECT agent_id, statement, status FROM intents WHERE repo_id = $1',
      [repoId],
    );
    expect(rows).toEqual([
      { agent_id: 'agent-1', statement: UNRELATED.a, status: 'in_flight' },
    ]);
  });

  it('returns blocked as a value, naming the holder and its intent — invariant 3', async () => {
    const slug = freshSlug('block');
    const key = 'file:src/server.ts';

    const first = await propose({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: [key],
    });
    expect(first.decision).toBe('granted');

    const second = await propose({
      repo: slug,
      agent_id: 'agent-2',
      statement: UNRELATED.b,
      resource_keys: [key],
    });

    expect(second.decision).toBe('blocked');
    // `05` §1: contested: Array<{ key, holder, intentId }>. Without the holder the
    // only thing a blocked agent can do is poll.
    // `holderStatement` crosses the boundary with the id. The id alone cannot be
    // dereferenced from the write plane — `04` §2 puts reads on `cortex_reader` — so an
    // agent handed only an id has nothing to re-plan around. V63 watched one wait instead.
    expect(second.contested).toEqual([
      expect.objectContaining({
        key,
        holder: 'agent-1',
        intentId: first.intentId,
        holderStatement: UNRELATED.a,
      }),
    ]);
  });

  it('returns deduped with the prior outcome, not a rejection — invariant 4', async () => {
    const slug = freshSlug('dedupe');

    const first = await propose({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: ['file:src/a.ts'],
    });
    expect(first.decision).toBe('granted');

    // Identical statement, so the distance is ~0 and the decision cannot be a
    // threshold accident. Different keys, so nothing here can block instead.
    const second = await propose({
      repo: slug,
      agent_id: 'agent-2',
      statement: UNRELATED.a,
      resource_keys: ['file:src/b.ts'],
    });

    expect(second.decision).toBe('deduped');
    expect(second.ofIntentId).toBe(first.intentId);
    expect(second.holder).toBe('agent-1');
    // Present and null: the first intent is in flight, so there is no outcome yet.
    // An absent key would leave an agent unable to tell "no outcome" from "not told".
    expect(second).toHaveProperty('outcome', null);

    // A deduped proposal leaves no trace: no second intent, no claim on b.ts.
    const repoId = await repoIdOf(slug);
    expect((await claimsFor(repoId)).map((c) => c.key)).toEqual(['file:src/a.ts']);
  });

  it('keeps two slugs apart — invariant 5, on the id this unit derives', async () => {
    const a = freshSlug('tenant-a');
    const b = freshSlug('tenant-b');
    const key = 'file:src/shared.ts';

    const first = await propose({
      repo: a,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: [key],
    });
    expect(first.decision).toBe('granted');

    // Same statement and same key in another tenant. If either the dedupe SELECT or
    // the claims read leaked across `repo_id`, this comes back deduped or blocked.
    const second = await propose({
      repo: b,
      agent_id: 'agent-2',
      statement: UNRELATED.a,
      resource_keys: [key],
    });
    expect(second.decision).toBe('granted');
  });

  it('arbitrates two concurrent calls to one winner — invariant 1 through the tool', async () => {
    // If the MCP layer ever answers from its own SQL instead of the single
    // arbitration transaction, this is where it shows: both calls are in flight at
    // once, so neither dedupe SELECT sees the other's intent and both reach the
    // claims INSERT. Exactly one may come out of that with the key.
    const slug = freshSlug('race');
    const key = 'file:src/contended.ts';

    const [one, two] = await Promise.all([
      propose({
        repo: slug,
        agent_id: 'agent-1',
        statement: UNRELATED.a,
        resource_keys: [key],
      }),
      propose({
        repo: slug,
        agent_id: 'agent-2',
        statement: UNRELATED.b,
        resource_keys: [key],
      }),
    ]);

    const decisions = [one.decision, two.decision].sort();
    expect(decisions).toEqual(['blocked', 'granted']);

    const claims = await claimsFor(await repoIdOf(slug));
    expect(claims.length, 'one key, one claim row').toBe(1);
  });
});

describe('glob: keys, against a configured repository root', () => {
  // `05` §3's `resource_keys` description advertises `glob:<pattern>`, and U8 refused
  // it because §6 configured the server with no checkout to match against. That gap
  // was recorded in docs/SPEC-DELTA.md rather than papered over; this closes it — §6
  // now names `CORTEX_REPO_ROOT`, and the server expands a glob when it is set.
  //
  // The expansion is what makes the grammar work, not a convenience: `03` §3 requires
  // a glob to be claimed as one row per matched file *plus* a row for the glob, so
  // that a later `file:` claim on a matched path collides. A bare `glob:` row would
  // grant twice with no error.
  let rooted: Client;

  beforeAll(async () => {
    const { getDefaultEnvironment } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    );

    rooted = new Client({ name: 'cortex-u8-glob-test', version: '0.0.0' });
    await rooted.connect(
      new StdioClientTransport({
        command: 'npx',
        args: ['tsx', 'scripts/serve-mcp.mts'],
        cwd: repoRoot,
        stderr: 'pipe',
        // Merged rather than replaced: the default environment carries PATH and HOME,
        // without which npx does not resolve and the AWS SDK finds no credentials.
        env: { ...getDefaultEnvironment(), CORTEX_REPO_ROOT: `${repoRoot}bench/fixtures` },
      }),
    );
  });

  afterAll(async () => {
    await rooted.close();
  });

  async function proposeRooted(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await rooted.callTool({
      name: 'cortex_propose',
      arguments: args,
    })) as ToolResult;
    expect(result.isError, `propose errored: ${JSON.stringify(result.content)}`).toBeFalsy();
    return JSON.parse(result.content![0]!.text!) as Record<string, unknown>;
  }

  it('claims one key per matched file, plus the glob itself', async () => {
    const slug = freshSlug('glob');

    const decision = await proposeRooted({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: ['glob:src/auth/**'],
    });

    expect(decision.decision).toBe('granted');
    expect(decision.keys).toEqual([
      'file:src/auth/login.ts',
      'file:src/auth/middleware.ts',
      'file:src/auth/password.ts',
      'file:src/auth/session.ts',
      'file:src/auth/token.ts',
      'glob:src/auth/**',
    ]);

    const claims = await claimsFor(await repoIdOf(slug));
    expect(claims.map((c) => c.key)).toEqual(decision.keys);
  });

  it('blocks a later file: claim on a path the glob already covers', async () => {
    // The overlap `03` §3 makes structural. Without the expansion this second call is
    // granted, two agents edit login.ts believing they hold different keys, and
    // nothing anywhere reports a conflict.
    const slug = freshSlug('glob-overlap');

    const first = await proposeRooted({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: ['glob:src/auth/**'],
    });
    expect(first.decision).toBe('granted');

    const second = await proposeRooted({
      repo: slug,
      agent_id: 'agent-2',
      statement: UNRELATED.b,
      resource_keys: ['file:src/auth/login.ts'],
    });

    expect(second.decision).toBe('blocked');
    expect(second.contested).toEqual([
      expect.objectContaining({ key: 'file:src/auth/login.ts', holder: 'agent-1' }),
    ]);
  });

  it('expands only inside the subtree the pattern names', async () => {
    // Not the 200-key limit — `bench/fixtures` has 40 files, so that bound cannot be
    // reached here and `test/propose.test.ts` already covers it against `expandKeys`
    // directly. What this checks is containment: a pattern naming one subtree must not
    // pull in keys from outside it, since every extra key is a claim taken against a
    // file the agent never asked for and did not intend to edit.
    const slug = freshSlug('glob-wide');

    const decision = await proposeRooted({
      repo: slug,
      agent_id: 'agent-1',
      statement: UNRELATED.a,
      resource_keys: ['glob:src/lib/**'],
    });

    expect(decision.decision).toBe('granted');
    for (const key of decision.keys as string[]) {
      expect(key.startsWith('file:src/lib/') || key === 'glob:src/lib/**').toBe(true);
    }
  });

  it('still refuses a glob when no root is configured', async () => {
    // The default server in the other describe block has no CORTEX_REPO_ROOT, so it
    // must keep refusing rather than expanding against whatever directory it happens
    // to have been launched from.
    await expect(
      client.callTool({
        name: 'cortex_propose',
        arguments: {
          repo: freshSlug('glob-unrooted'),
          agent_id: 'agent-1',
          statement: UNRELATED.a,
          resource_keys: ['glob:src/**'],
        },
      }),
    ).rejects.toThrow(/CORTEX_REPO_ROOT|no repository checkout/i);
  });
});

describe('invariant 7 — the handler is reachable only through declared arguments', () => {
  async function refuses(args: Record<string, unknown>, pattern: RegExp): Promise<void> {
    await expect(
      client.callTool({ name: 'cortex_propose', arguments: args }),
      `should refuse ${JSON.stringify(args)}`,
    ).rejects.toThrow(pattern);
  }

  // Unique per run, and registered for teardown. Both matter: a fixed slug makes
  // this assertion depend on every previous run having also passed, and a slug
  // outside the teardown list survives the run that proves it should not exist.
  const valid = {
    repo: freshSlug('refused'),
    agent_id: 'agent-1',
    statement: UNRELATED.a,
    resource_keys: ['file:src/a.ts'],
  };

  it('refuses a call missing a required argument', async () => {
    const { statement: _omitted, ...withoutStatement } = valid;
    await refuses(withoutStatement, /statement/i);
  });

  it('refuses an argument of the wrong type', async () => {
    await refuses({ ...valid, resource_keys: 'file:src/a.ts' }, /resource_keys/i);
    await refuses({ ...valid, statement: 42 }, /statement/i);
  });

  it('enforces the bounds the spec publishes', async () => {
    await refuses({ ...valid, statement: 'x'.repeat(501) }, /500/);
    await refuses(
      { ...valid, resource_keys: Array.from({ length: 201 }, (_, i) => `file:src/f${i}.ts`) },
      /200/,
    );
  });

  it('refuses a resource key that escapes the repo, rather than claiming it', async () => {
    await refuses({ ...valid, resource_keys: ['file:../../etc/passwd'] }, /escapes the repo/i);
    await refuses({ ...valid, resource_keys: [] }, /at least one/i);
  });

  it('creates no repo row for a call it refused', async () => {
    // A refusal that has already written a tenant row is a way to mint tenants with
    // arguments the boundary rejected.
    const { rows } = await getPool().query('SELECT count(*) AS n FROM repos WHERE slug = $1', [
      valid.repo,
    ]);
    expect(Number((rows[0] as { n: string }).n)).toBe(0);
  });
});
