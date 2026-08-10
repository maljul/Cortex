// Covers spec/03-MEMORY-MODEL.md §5 (concurrency handling) and §8 item 7:
// "A forced 40001 is retried and eventually commits."
//
// Every conflict in this file is a genuine SQLSTATE 40001 produced by two real
// SERIALIZABLE transactions on the cluster named by CORTEX_DSN. Nothing is mocked;
// a fake 40001 would prove only that the wrapper can read its own error constant.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { closePool, getPool } from '../src/db/pool.js';
import {
  BASE_DELAY_MS,
  backoffMs,
  getRetryCount,
  MAX_ATTEMPTS,
  resetRetryCount,
  withRetry,
} from '../src/db/retry.js';

/** A promise plus its resolver, used to interleave two live transactions. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function readProbe(): Promise<number> {
  const { rows } = await getPool().query('SELECT n FROM retry_probe WHERE id = 1');
  return Number(rows[0].n);
}

beforeAll(async () => {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS retry_probe (
      id INT8 PRIMARY KEY,
      n  INT8 NOT NULL
    )
  `);
});

beforeEach(async () => {
  await getPool().query(`
    INSERT INTO retry_probe (id, n) VALUES (1, 0)
    ON CONFLICT (id) DO UPDATE SET n = 0
  `);
  resetRetryCount();
});

afterAll(async () => {
  await getPool().query('DROP TABLE IF EXISTS retry_probe');
  await closePool();
});

describe('withRetry', () => {
  test('commits the transaction and returns the callback result', async () => {
    const result = await withRetry(async (client) => {
      await client.query('UPDATE retry_probe SET n = 7 WHERE id = 1');
      return 'committed';
    });

    expect(result).toBe('committed');
    expect(await readProbe()).toBe(7);
    expect(getRetryCount()).toBe(0);
  });

  test('rolls back and rethrows an error that is not a serialization failure', async () => {
    const boom = new Error('boom');

    await expect(
      withRetry(async (client) => {
        await client.query('UPDATE retry_probe SET n = 99 WHERE id = 1');
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await readProbe()).toBe(0);
    expect(getRetryCount()).toBe(0);
  });

  // Guards the guard: proves the interleaving below really does make the cluster
  // raise 40001, so the recovery test cannot pass against a conflict-free harness.
  test('the interleaving used below raises a real 40001 on raw clients', async () => {
    const a = await getPool().connect();
    const b = await getPool().connect();

    try {
      await a.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await b.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      // Both transactions read the same row at the same logical timestamp.
      const aRead = Number((await a.query('SELECT n FROM retry_probe WHERE id = 1')).rows[0].n);
      await b.query('SELECT n FROM retry_probe WHERE id = 1');

      // A writes what it read and commits. B's read of that row can no longer be
      // refreshed, so B's write must be rejected rather than silently lost.
      await a.query('UPDATE retry_probe SET n = $1 WHERE id = 1', [aRead + 1]);
      await a.query('COMMIT');

      const conflict = await b
        .query('UPDATE retry_probe SET n = 42 WHERE id = 1')
        .then(() => b.query('COMMIT'))
        .then(
          () => null,
          (error: unknown) => error as { code?: string },
        );

      expect(conflict).not.toBeNull();
      expect(conflict?.code).toBe('40001');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  test('recovers from a forced 40001 and increments the retry counter', async () => {
    const loserHasRead = deferred();
    const winnerHasCommitted = deferred();
    let loserAttempts = 0;

    // Winner: reads, waits for the loser to read the same row, then writes.
    const winner = withRetry(async (client) => {
      const { rows } = await client.query('SELECT n FROM retry_probe WHERE id = 1');
      await loserHasRead.promise;
      await client.query('UPDATE retry_probe SET n = $1 WHERE id = 1', [Number(rows[0].n) + 1]);
    }).then(() => winnerHasCommitted.resolve());

    // Loser: on its first attempt it reads, lets the winner commit underneath it,
    // and only then writes — which the cluster must reject with 40001.
    const loser = withRetry(async (client) => {
      const attempt = ++loserAttempts;
      const { rows } = await client.query('SELECT n FROM retry_probe WHERE id = 1');

      if (attempt === 1) {
        loserHasRead.resolve();
        await winnerHasCommitted.promise;
      }

      await client.query('UPDATE retry_probe SET n = $1 WHERE id = 1', [Number(rows[0].n) + 1]);
    });

    await Promise.all([winner, loser]);

    // The loser ran twice: once into the conflict, once cleanly on the value the
    // winner committed. Both increments survive — no lost update.
    expect(loserAttempts).toBe(2);
    expect(getRetryCount()).toBe(1);
    expect(await readProbe()).toBe(2);
  });

  test('gives up after five attempts when the conflict never clears', async () => {
    let attempts = 0;

    // A committed writer moves the row after every read, so each attempt hits a
    // fresh, genuine 40001 and the cap is what finally stops the loop.
    const doomed = withRetry(async (client) => {
      attempts += 1;
      const { rows } = await client.query('SELECT n FROM retry_probe WHERE id = 1');
      await getPool().query('UPDATE retry_probe SET n = n + 1 WHERE id = 1');
      await client.query('UPDATE retry_probe SET n = $1 WHERE id = 1', [Number(rows[0].n) + 100]);
    });

    await expect(doomed).rejects.toMatchObject({ code: '40001' });
    expect(attempts).toBe(5);
    expect(getRetryCount()).toBe(4);
  });

  test('never retries in a tight loop', async () => {
    const startedAt: number[] = [];

    const doomed = withRetry(async (client) => {
      startedAt.push(Date.now());
      const { rows } = await client.query('SELECT n FROM retry_probe WHERE id = 1');
      await getPool().query('UPDATE retry_probe SET n = n + 1 WHERE id = 1');
      await client.query('UPDATE retry_probe SET n = $1 WHERE id = 1', [Number(rows[0].n) + 100]);
    });

    await expect(doomed).rejects.toMatchObject({ code: '40001' });
    expect(startedAt).toHaveLength(5);

    // Only that a gap exists. This test used to also assert the last gap exceeded the
    // first, and that assertion was measuring the network rather than the backoff: an
    // attempt spends about a second in round trips to CockroachDB Cloud against 20–180ms
    // of sleep, so jitter decides the comparison. It failed with
    // `expected 1048 to be greater than 1048`, and would have passed just as happily
    // with the backoff deleted.
    //
    // The growth is asserted directly below, against `backoffMs`, where it is real.
    // `slice(1)` means index i of the original always exists for every i here, and the
    // length assertion above fixes gaps at four entries.
    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(0);
    }
  });
});

describe('backoffMs — §5 exponential backoff with jitter', () => {
  // A pure function, so the property can be asserted exactly instead of inferred from
  // a stopwatch. This is where "exponential" is actually checked.
  const attempts = [1, 2, 3, 4];

  test('grows exponentially, and consecutive attempts cannot overlap', () => {
    // 200 draws per attempt: with jitter this either holds for every draw or the
    // windows overlap and it fails almost immediately.
    for (let draw = 0; draw < 200; draw += 1) {
      const delays = attempts.map((attempt) => backoffMs(attempt));
      for (let i = 1; i < delays.length; i += 1) {
        expect(
          delays[i]!,
          `attempt ${i + 1} (${delays[i]}) must exceed attempt ${i} (${delays[i - 1]})`,
        ).toBeGreaterThan(delays[i - 1]!);
      }
    }
  });

  test('stays inside the window its base and jitter allow', () => {
    for (const attempt of attempts) {
      const base = BASE_DELAY_MS * 2 ** (attempt - 1);
      for (let draw = 0; draw < 200; draw += 1) {
        const delay = backoffMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThan(base + BASE_DELAY_MS);
      }
    }
  });

  test('caps at the five attempts §5 allows', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
