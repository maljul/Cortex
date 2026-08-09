import { Pool } from 'pg';

let pool: Pool | undefined;

/**
 * The write-plane connection pool. Lazily created so importing this module never
 * opens a socket, and so a missing DSN fails at first use with a clear message.
 */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.CORTEX_DSN;

    if (!connectionString) {
      throw new Error(
        'CORTEX_DSN is empty. The write plane needs a CockroachDB connection string in .env.',
      );
    }

    // Fail promptly rather than hanging. `04-ARCHITECTURE.md` §6 requires the CLI to
    // fail closed when the cluster is unreachable; a hang is not a closed failure,
    // it is an unbounded wait that reports someone else's timeout instead of ours.
    pool = new Pool({
      connectionString,
      application_name: 'cortex',
      connectionTimeoutMillis: 10_000,
    });
  }

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}
