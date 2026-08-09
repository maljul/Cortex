import type { PoolClient } from 'pg';

import { getPool } from './pool';

/** SQLSTATE for a serialization failure. Under SERIALIZABLE this is expected traffic. */
const SERIALIZATION_FAILURE = '40001';

/** spec/03-MEMORY-MODEL.md §5: capped at five attempts. */
const MAX_ATTEMPTS = 5;

const BASE_DELAY_MS = 20;

let retries = 0;

/**
 * Retries performed since the last reset. Exported as a metric on purpose:
 * §5 wants serialization conflicts shown, not hidden.
 */
export function getRetryCount(): number {
  return retries;
}

export function resetRetryCount(): void {
  retries = 0;
}

function isSerializationFailure(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === SERIALIZATION_FAILURE;
}

/** Exponential, with jitter on top so a fleet of agents does not retry in lockstep. */
function backoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * BASE_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The server may have aborted the transaction already; nothing left to undo.
  }
}

/**
 * Runs `fn` inside a SERIALIZABLE transaction and commits it.
 *
 * A 40001 rolls back and retries with exponential backoff plus jitter, up to five
 * attempts, then rethrows. Any other error rolls back and rethrows immediately —
 * retrying it would just repeat the same failure.
 */
export async function withRetry<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackQuietly(client);

      if (!isSerializationFailure(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }

      retries += 1;
      await sleep(backoffMs(attempt));
    } finally {
      client.release();
    }
  }

  /* c8 ignore next */
  throw new Error('unreachable: the retry loop either returns or throws');
}
