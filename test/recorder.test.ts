/**
 * THE SHOW-SQL RECORDER — spec/05-INTERFACES.md §5, spec/07 §2.
 *
 * `07` §2 puts a "show SQL" toggle on the memory panel, and U16's named silent break is
 * that panel printing SQL the system did not run. This file is the guard: a statement can
 * reach the log only by having been handed to the driver, so the panel is a transcript
 * rather than an illustration.
 *
 * The last test is the one worth keeping. `03` §8 invariant 1 says dedupe and claim share
 * one transaction, "if they were split the project's thesis would be falsified by its own
 * code" — and the recorded log makes that visible: one BEGIN, the dedupe SELECT and the
 * claims INSERT inside it, one COMMIT. A sceptical judge can read the invariant off the
 * panel instead of taking it on trust, which is exactly what the panel is for.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import { StatementRecorder } from '../src/db/recorder.js';
import { withRetry } from '../src/db/retry.js';
import { propose } from '../src/memory/propose.js';

import { vector } from './helpers/vectors.js';

const repos: string[] = [];

async function freshRepo(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO repos (slug) VALUES ($1) RETURNING id',
    [`recorder-test/${randomUUID()}`],
  );
  repos.push(rows[0]!.id);
  return rows[0]!.id;
}

afterAll(async () => {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  for (const repo of repos) {
    for (const table of ['claims', 'intents', 'findings', 'action_ledger', 'agents']) {
      await admin.query(`DELETE FROM ${table} WHERE repo_id = $1`, [repo]);
    }
    await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
  }
  await admin.end();
  await closePool();
});

describe('the recorder writes down what ran, and only what ran', () => {
  it('records a statement with its timing and row count', async () => {
    const recorder = new StatementRecorder();

    await withRetry(
      async (client) => client.query('SELECT 1 AS n, $1::INT AS given', [7]),
      { recorder },
    );

    const executed = recorder.statements.find((s) => s.sql.startsWith('SELECT 1 AS n'));
    expect(executed).toBeDefined();
    expect(executed?.parameters).toBe(1);
    expect(executed?.rows).toBe(1);
    expect(executed?.ms).toBeGreaterThanOrEqual(0);
  });

  /**
   * The silent break, asserted directly: nothing composes SQL for display. If the panel
   * ever shows a statement, it is because that exact text went to CockroachDB.
   */
  it('records the transaction and nothing else when no query is issued', async () => {
    const recorder = new StatementRecorder();
    await withRetry(async () => 'no queries here', { recorder });

    // The BEGIN and COMMIT are real statements that really ran, so they belong in the
    // log. What must not be there is anything the caller did not execute.
    expect(recorder.statements.map((s) => s.sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
  });

  it('records parameter counts, never parameter values', async () => {
    const recorder = new StatementRecorder();
    const secret = 'postgresql://user:hunter2@host/db';

    await withRetry(async (client) => client.query('SELECT $1::STRING AS s', [secret]), {
      recorder,
    });

    const log = JSON.stringify(recorder.statements);
    expect(log).not.toContain('hunter2');
    expect(log).not.toContain(secret);
    expect(recorder.statements.find((s) => s.sql.includes('$1::STRING'))?.parameters).toBe(1);
  });

  it('does not record a statement that failed', async () => {
    const recorder = new StatementRecorder();

    await expect(
      withRetry(async (client) => client.query('SELECT * FROM no_such_table_here'), { recorder }),
    ).rejects.toThrow();

    expect(recorder.statements.some((s) => s.sql.includes('no_such_table_here'))).toBe(false);
  });
});

describe('the log shows the arbitration transaction — invariant 1', () => {
  it('puts the dedupe SELECT and the claims INSERT inside one BEGIN', async () => {
    const repo = await freshRepo();
    const recorder = new StatementRecorder();

    const decision = await propose({
      repoId: repo,
      agentId: 'recorder-agent',
      statement: 'add a retry to the orders client',
      resourceKeys: ['file:src/orders/client.ts'],
      embedding: vector(900),
      recorder,
    });
    expect(decision.decision).toBe('granted');

    const log = recorder.statements.map((s) => s.sql);

    const begins = log.filter((sql) => sql.startsWith('BEGIN')).length;
    const dedupe = log.findIndex((sql) => /FROM intents/.test(sql) && /<=>/.test(sql));
    const claim = log.findIndex((sql) => /INSERT INTO claims/.test(sql));
    const commits = log.filter((sql) => sql.startsWith('COMMIT')).length;

    expect(dedupe).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(dedupe);

    // One transaction. Two BEGINs here would mean the similarity check and the claim ran
    // against different snapshots, which is the falsification invariant 1 describes.
    expect(begins).toBe(1);
    expect(commits).toBe(1);
  });
});
