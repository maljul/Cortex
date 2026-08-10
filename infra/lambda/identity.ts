/**
 * The deploy spike's Lambda handler. `08` §7's "hello-world through the full
 * pipeline", which the risk register wanted on day one evening.
 *
 * It returns `clusterIdentity()` rather than a string, on purpose. A handler that
 * returns "hello" proves that API Gateway reached Lambda and nothing else; the risk
 * this spike exists to burn down is **Lambda → CockroachDB Cloud** — TLS, cold-start
 * latency, and a Basic-tier connection limit against compute that is never long-lived.
 * A 200 carrying the cluster's own build string is the whole path answering.
 *
 * `src/db/identity.ts` is reused unchanged: read-only, no transaction, no tenant data,
 * so invariant 5 has nothing to filter here and this adds no new SQL to the project.
 *
 * ON THE DSN, stated rather than papered over: `clusterIdentity()` goes through
 * `getPool()`, which reads `CORTEX_DSN`. This function's `CORTEX_DSN` is set to the
 * **reader** principal's connection string — the spike has no business holding a write
 * credential, and `05` §6 keeps every DSN server side. The variable therefore names the
 * write plane while carrying the read plane's value, which is fine for a spike and is
 * not fine for U14: the real write path needs `getPool()` to take a DSN, or a second
 * pool. That is U14's scope, not this file's.
 *
 * No credential is ever returned. `ClusterIdentity` carries `version`, `user` and
 * `database`; the DSN is never echoed, per that module's own header.
 */
import { clusterIdentity } from '../../src/db/identity.js';

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Measured from module load, so the first invocation reports cold-start cost and every
 * warm one reports roughly zero. `08` §7 wants the connection behaviour observed, not
 * assumed, and this is the cheapest place to observe it.
 */
const loadedAt = Date.now();
let invocations = 0;

/**
 * Bumped by hand on each redeploy. Without it a redeploy and a no-op are
 * indistinguishable from outside, and the redeploy timing in V22 would be measuring a
 * command rather than an effect.
 */
const BUNDLE_REVISION = 3;

export async function handler(): Promise<Response> {
  const startedAt = Date.now();
  invocations += 1;

  try {
    const identity = await clusterIdentity();

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        {
          cluster: identity,
          bundleRevision: BUNDLE_REVISION,
          timing: {
            queryMs: Date.now() - startedAt,
            sinceModuleLoadMs: startedAt - loadedAt,
            invocationsOnThisSandbox: invocations,
          },
        },
        null,
        2,
      ),
    };
  } catch (error) {
    // Fail closed and say why. `04` §6 requires the CLI to fail closed when the cluster
    // is unreachable, and the same applies here — a spike that swallows a TLS failure
    // and answers 200 would have burned down nothing.
    const failure = error as { code?: string; message: string };

    return {
      statusCode: 502,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        { error: failure.message, code: failure.code ?? null, sinceModuleLoadMs: startedAt - loadedAt },
        null,
        2,
      ),
    };
  }
}
