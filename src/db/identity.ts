/**
 * Who we are connected to, for `06` §7.2: "Publish the environment: cluster tier,
 * region, model ids, dates."
 *
 * The alternative was to copy the cluster's name and region out of `CLAUDE.md` into
 * `environment.json` by hand, which is how a published environment block comes to
 * describe a cluster the benchmark did not run against. This asks the server.
 *
 * Read-only, no transaction, no `withRetry`, and no tenant data — `version()`,
 * `current_user` and `current_database` are properties of the connection, so invariant
 * 5 has nothing to filter here. Prints no credential: the DSN is never echoed.
 */
import { getPool, type Plane } from './pool.js';

export interface ClusterIdentity {
  /** e.g. `CockroachDB CCL v25.x …`. The build string, verbatim. */
  version: string;
  /** The SQL user the named plane connects as. Not a secret; the password is. */
  user: string;
  database: string;
}

export async function clusterIdentity(plane: Plane = 'write'): Promise<ClusterIdentity> {
  const { rows } = await getPool(plane).query(
    'SELECT version() AS version, current_user AS "user", current_database() AS database',
  );
  const row = rows[0] as ClusterIdentity;

  return { version: row.version, user: row.user, database: row.database };
}
