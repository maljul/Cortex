import { Pool } from 'pg';

/**
 * Which privilege plane a connection belongs to. `04-ARCHITECTURE.md` §3 defines three;
 * two of them are reachable from code that opens a pool.
 *
 * - `write` — `CORTEX_DSN`. The CLI and the MCP tools. **`04` §3 names this plane
 *   `cortex_writer` and it is not: the variable connects as `julian`, a cluster admin.**
 *   This comment claimed otherwise until 2026-08-13, when `/check` found it blind (V40) —
 *   nothing asserted the principal, unlike the two planes below, and the missing assertion
 *   is exactly the one that would have caught it. The deviation is recorded in
 *   `docs/SPEC-DELTA.md` and pinned by `test/privilege-planes.test.ts`.
 *   **What it costs, measured rather than assumed (V47):** nothing in `src/`, nothing in
 *   `test/` and nothing in the deployment depends on the extra privilege — the application
 *   layer issues only SELECT/INSERT/UPDATE/DELETE. Because every `writer_all` policy is
 *   `USING (true) WITH CHECK (true)`, `cortex_writer` would reach exactly the same rows, so
 *   the gap removes DDL and changefeed control and no data access at all. Invariant 7 already
 *   forbids an agent-reachable path from accepting SQL or a table name, so against §3's own
 *   threat — a prompt-injected agent — closing it buys nothing.
 * - `demo`  — `cortex_demo`, via `CORTEX_DEMO_DSN`. The hosted demo, and nothing else.
 *
 * The read plane is deliberately absent. `cortex_reader` is reached by agents with a
 * DSN and a stock client (`skills/cortex-memory/SKILL.md`), not by this process.
 */
export type Plane = 'write' | 'demo';

const DSN_VARIABLE: Record<Plane, string> = {
  write: 'CORTEX_DSN',
  demo: 'CORTEX_DEMO_DSN',
};

const pools = new Map<Plane, Pool>();

/**
 * The connection pool for one privilege plane. Lazily created so importing this module
 * never opens a socket, and so a missing DSN fails at first use with a clear message.
 *
 * **One pool per plane, from one variable per plane, and never a shared default.** This
 * function used to read `CORTEX_DSN` and nothing else, which made the demo's principal a
 * deployment detail rather than a property of the code: pointing that single variable at
 * a write principal to give one Lambda a write verb would have given it to every other
 * function in the deployment at the same time. U14 named that as its silent break before
 * building on top of it, and `test/demo-plane.test.ts` asserts the two planes connect as
 * different SQL users rather than trusting this comment.
 */
export function getPool(plane: Plane = 'write'): Pool {
  const existing = pools.get(plane);
  if (existing) return existing;

  const variable = DSN_VARIABLE[plane];
  const connectionString = process.env[variable];

  if (!connectionString) {
    throw new Error(
      `${variable} is empty. The ${plane} plane needs a CockroachDB connection string in .env.`,
    );
  }

  // Fail promptly rather than hanging. `04-ARCHITECTURE.md` §6 requires the CLI to
  // fail closed when the cluster is unreachable; a hang is not a closed failure,
  // it is an unbounded wait that reports someone else's timeout instead of ours.
  const pool = new Pool({
    connectionString,
    application_name: `cortex-${plane}`,
    connectionTimeoutMillis: 10_000,
  });

  pools.set(plane, pool);
  return pool;
}

/** Closes one plane's pool, or every open pool when called with no argument. */
export async function closePool(plane?: Plane): Promise<void> {
  const planes: Plane[] = plane ? [plane] : [...pools.keys()];

  await Promise.all(
    planes.map(async (p) => {
      const closing = pools.get(p);
      if (!closing) return;
      pools.delete(p);
      await closing.end();
    }),
  );
}
