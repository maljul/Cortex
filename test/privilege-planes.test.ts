/**
 * PRIVILEGE PLANES — asserted by attempting the write, never by reading a catalogue.
 * spec/04-ARCHITECTURE.md §3, spec/03-MEMORY-MODEL.md §8 test 9.
 *
 * V9 is why this file exists. All three service accounts were members of `admin`,
 * and `SHOW GRANTS ON TABLE claims` showed exactly the narrow grants
 * `sql/001_init.sql` writes — the catalogue answered the narrow question truthfully
 * while the account held everything through a role membership the question never
 * asked about. So nothing here reads a grant. Every claim is made by issuing the
 * statement and requiring the cluster to refuse it.
 *
 * Until now that finding lived only in `docs/verification-log.md`, which does not
 * fail when someone re-grants. This is the regression guard.
 *
 * **This is not §8 test 9.** Test 9 asks that `cortex_demo` cannot write outside a
 * *live demo session scope*, which needs the confinement mechanism `04` §3 leaves
 * `[OPEN]`. What is asserted here is the weaker, current state: `cortex_demo` holds
 * no privilege at all. When §3 is decided and the principal gains scoped grants,
 * the demo block below stops being true and must be rewritten into test 9 proper —
 * it is designed to fail loudly at that moment rather than quietly keep passing.
 */
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { vector } from './helpers/vectors.js';

/** CockroachDB's SQLSTATE for insufficient privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

const TABLES = ['repos', 'agents', 'claims', 'intents', 'findings', 'action_ledger'] as const;

interface Attempt {
  allowed: boolean;
  code: string | undefined;
  message: string;
}

/**
 * Runs one statement on its own connection and reports what happened.
 *
 * Writes go inside a transaction that is always rolled back. A refusal throws either
 * way, so the rollback matters only in the case the test exists to catch: if a write
 * unexpectedly succeeds, the assertion fails *and* the row does not survive to
 * confuse the next run.
 */
async function attempt(dsn: string, sql: string, write: boolean): Promise<Attempt> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();

  try {
    if (write) await client.query('BEGIN');
    await client.query(sql);
    if (write) await client.query('ROLLBACK');
    return { allowed: true, code: undefined, message: '' };
  } catch (error) {
    const failure = error as { code?: string; message: string };
    return { allowed: false, code: failure.code, message: failure.message };
  } finally {
    await client.end();
  }
}

async function currentUser(dsn: string): Promise<string> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_user AS who');
    return (rows[0] as { who: string }).who;
  } finally {
    await client.end();
  }
}

/** A syntactically valid write per table, so a refusal is about privilege and nothing else. */
function writeStatement(table: string): string {
  const embedding = `[${vector(1).join(',')}]`;

  switch (table) {
    case 'repos':
      return "INSERT INTO repos (slug) VALUES ('privilege-probe/should-not-exist')";
    case 'agents':
      return `INSERT INTO agents (id, repo_id, kind, session_id)
              VALUES ('privilege-probe', gen_random_uuid(), 'scripted', gen_random_uuid())`;
    case 'claims':
      return `INSERT INTO claims (repo_id, resource_key, intent_id, holder, expires_at)
              VALUES (gen_random_uuid(), 'file:privilege-probe', gen_random_uuid(),
                      'privilege-probe', now() + '1 minute')`;
    case 'intents':
      return `INSERT INTO intents (repo_id, agent_id, statement, resource_keys, embedding)
              VALUES (gen_random_uuid(), 'privilege-probe', 'probe',
                      ARRAY['file:privilege-probe'], '${embedding}')`;
    case 'findings':
      return `INSERT INTO findings (repo_id, fact, embedding)
              VALUES (gen_random_uuid(), 'probe', '${embedding}')`;
    case 'action_ledger':
      return `INSERT INTO action_ledger (repo_id, intent_id, idempotency_key, action, payload_digest)
              VALUES (gen_random_uuid(), gen_random_uuid(), 'privilege-probe', 'probe', 'probe')`;
    default:
      throw new Error(`no write statement for ${table}`);
  }
}

/**
 * Reads a DSN or fails the test with the reason.
 *
 * Deliberately not `it.skip`. A skipped privilege test reports green over an
 * unasserted boundary, which is the exact shape of "N/N passed" standing in for
 * coverage that does not exist.
 */
function dsn(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set in .env, so this privilege plane is unasserted. ` +
        'Set it to a connection string for that principal and re-run. Do not skip ' +
        'this file: an unasserted boundary that reports green is how V9 survived.',
    );
  }
  return value;
}

describe('the reader plane reads and cannot write (`04` §3)', () => {
  it('connects as cortex_reader and not as someone else', async () => {
    expect(await currentUser(dsn('CORTEX_READER_DSN'))).toBe('cortex_reader');
  });

  it.each(TABLES)('can SELECT %s', async (table) => {
    const result = await attempt(
      dsn('CORTEX_READER_DSN'),
      `SELECT count(*) FROM ${table}`,
      false,
    );
    expect(result.allowed, `SELECT ${table} was refused: ${result.message}`).toBe(true);
  });

  it.each(TABLES)('cannot INSERT into %s', async (table) => {
    const result = await attempt(dsn('CORTEX_READER_DSN'), writeStatement(table), true);
    expect(result.allowed, `INSERT into ${table} was ALLOWED — the reader can write`).toBe(false);
    expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot UPDATE, DELETE or DROP', async () => {
    const statements = [
      "UPDATE claims SET holder = 'privilege-probe' WHERE resource_key = 'file:nothing-matches'",
      "DELETE FROM claims WHERE resource_key = 'file:nothing-matches'",
      'DROP TABLE findings',
    ];

    for (const sql of statements) {
      const result = await attempt(dsn('CORTEX_READER_DSN'), sql, true);
      expect(result.allowed, `ALLOWED, and it must not be: ${sql}`).toBe(false);
      expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });
});

describe('the demo principal holds no privilege at all (`04` §3 `[OPEN]`)', () => {
  it('connects as cortex_demo and not as someone else', async () => {
    expect(await currentUser(dsn('CORTEX_DEMO_DSN'))).toBe('cortex_demo');
  });

  it.each(TABLES)('cannot read %s', async (table) => {
    const result = await attempt(dsn('CORTEX_DEMO_DSN'), `SELECT count(*) FROM ${table}`, false);
    expect(result.allowed, `SELECT ${table} was ALLOWED — cortex_demo can read memory`).toBe(
      false,
    );
    expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it.each(TABLES)('cannot write %s', async (table) => {
    const result = await attempt(dsn('CORTEX_DEMO_DSN'), writeStatement(table), true);
    expect(result.allowed, `INSERT into ${table} was ALLOWED — cortex_demo can write memory`).toBe(
      false,
    );
    expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
