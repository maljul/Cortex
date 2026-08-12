import type { PoolClient } from 'pg';

import { getPool, type Plane } from './pool.js';
import type { StatementRecorder } from './recorder.js';

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

/**
 * Whether this is a SERIALIZABLE conflict.
 *
 * Exported because a caller sometimes needs to know that a 40001 **survived** all five
 * attempts. `03` §5 caps the helper there deliberately — "losing fast and re-planning is
 * the desired behaviour" — so what happens after the cap is the caller's decision, not
 * this module's, and the caller cannot make it without being able to recognise the error.
 * `src/demo/scenario.ts` is the first caller with genuinely concurrent agents and so the
 * first one for which the cap is reachable at all.
 */
export function isSerializationFailure(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === SERIALIZATION_FAILURE;
}

/**
 * Exponential, with jitter on top so a fleet of agents does not retry in lockstep.
 *
 * Exported for the tests. The growth cannot be observed end to end: an attempt against
 * CockroachDB Cloud spends roughly a second in round trips and 20–180ms in here, so a
 * test that times the gaps between attempts is measuring the network. It read
 * `expected 1048 to be greater than 1048` once, and would equally have passed with the
 * backoff removed entirely. The property is tested directly instead.
 *
 * The jitter window is one `BASE_DELAY_MS`, which is deliberately narrower than the
 * gap between consecutive attempts, so successive delays cannot overlap however the
 * random draw falls.
 */
export function backoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * BASE_DELAY_MS;
}

export { BASE_DELAY_MS, MAX_ATTEMPTS };

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

export interface RetryOptions {
  /** Which privilege plane to borrow a connection from. Defaults to the write plane. */
  plane?: Plane;
  /**
   * The demo session scope to set on the connection before any statement runs, per
   * `05` §5. Only meaningful on the `demo` plane; on any other it is a no-op that the
   * policies would ignore anyway.
   */
  demoSession?: string;
  /**
   * Collects the statements this transaction actually executes, for `05` §5's
   * `GET /demo/sql-log`. Only successful statements are recorded — a statement that threw
   * produced no rows and no timing, and the panel is showing what ran, not what was
   * attempted. Retried attempts each appear, which is correct: a 40001 retry really did
   * execute the statement twice.
   */
  recorder?: StatementRecorder;
}

/**
 * Runs `fn` inside a SERIALIZABLE transaction and commits it.
 *
 * A 40001 rolls back and retries with exponential backoff plus jitter, up to five
 * attempts, then rethrows. Any other error rolls back and rethrows immediately —
 * retrying it would just repeat the same failure.
 *
 * **On `demoSession`, and why it is not a `SET`.** `05` §5 requires the demo path to
 * scope its connection before touching a table, and writes that requirement as
 * `SET cortex.demo_session = '<id>'`. That statement takes no bind parameter, so
 * implementing it literally means interpolating into SQL a value that arrived from an
 * anonymous browser — invariant 7, on the one surface in this project that strangers can
 * reach. `set_config(name, $1, is_local)` is the same setting reached through a function
 * call, so the value binds. Verified against the real cluster before this was written
 * (V26): the policies honour it identically.
 *
 * `is_local = true` is the second half. The setting then ends at COMMIT, so a pooled
 * connection returns to the pool carrying no scope at all and the next visitor's request
 * starts from `current_setting` returning empty — which the policies match nothing
 * against. One request cannot inherit another's scope, and the failure mode of a bug in
 * this function is an empty page rather than someone else's session.
 */
export async function withRetry<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const pool = getPool(options.plane ?? 'write');

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const borrowed = await pool.connect();
    // Wrapped before BEGIN, not around `fn` alone, so the transaction boundary is in the
    // log too. `07` §2's panel is showing that dedupe and claim sit inside **one** BEGIN;
    // a log that omitted the BEGIN would be asking the reader to take that on trust.
    const client = options.recorder ? options.recorder.wrap(borrowed) : borrowed;

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      if (options.demoSession !== undefined) {
        await client.query('SELECT set_config($1, $2, true)', [
          'cortex.demo_session',
          options.demoSession,
        ]);
      }

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
      borrowed.release();
    }
  }

  /* c8 ignore next */
  throw new Error('unreachable: the retry loop either returns or throws');
}
