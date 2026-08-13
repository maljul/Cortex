/**
 * THE DEMO PLANE — the hosted demo's connection, its session scope, and its routes.
 * spec/05-INTERFACES.md §5, spec/03-MEMORY-MODEL.md §7, spec/04-ARCHITECTURE.md §3.
 *
 * U15 proved the *cluster* confines `cortex_demo` (test 9, `privilege-planes.test.ts`).
 * This file is about the layer above it: the code that opens that connection, scopes it,
 * and answers an anonymous browser. Four §8 invariants are reachable from here and each
 * has assertions below.
 *
 * - **5 — every read carries `WHERE repo_id`.** Row-level security would filter these
 *   queries even if they forgot to. That is exactly why the SQL is asserted directly:
 *   a query that leans on RLS is one policy edit away from V5's fail-open, and it would
 *   pass every behavioural test in this file while doing so.
 * - **6 — every write path is wrapped in the retry helper.** Session creation is a write.
 * - **7 — no agent-reachable path accepts a structural parameter.** `SET cortex.demo_session
 *   = '<id>'` takes no bind parameter, so the obvious implementation interpolates a value
 *   that arrived from an anonymous browser. `set_config(name, $1, true)` does bind, and
 *   the hostile-id test below is what holds the implementation to it.
 * - **8 — no credential field on any demo surface.** `05` §5 requires a request carrying
 *   one to be *rejected* rather than ignored, so it is asserted as a refusal.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { handleDemoRequest } from '../src/demo/api.js';
import { closePool, getPool } from '../src/db/pool.js';
import { withRetry } from '../src/db/retry.js';
import {
  DEMO_CLAIMS_SQL,
  DEMO_FINDINGS_SQL,
  DEMO_INTENTS_SQL,
  DEMO_LEDGER_SQL,
  DEMO_ROW_COUNT_SQL,
  createDemoSession,
  demoState,
} from '../src/memory/demo.js';

afterAll(async () => {
  await closePool();
});

/**
 * Creates a real repository — `demo_expires_at IS NULL` — and hands back its id.
 *
 * The tests below need one to point the demo path at, and they create it rather than
 * looking one up: `repos` is empty on this cluster more often than not, because every
 * suite that registers one deletes it again. A test that skipped when it found nothing
 * would be a test that never ran.
 */
async function realRepository(): Promise<{ id: string; drop: () => Promise<void> }> {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();

  const slug = `demo-plane-test/real-${randomUUID()}`;
  const { rows } = await admin.query<{ id: string }>(
    'INSERT INTO repos (slug) VALUES ($1) RETURNING id',
    [slug],
  );
  const id = rows[0]!.id;

  return {
    id,
    drop: async () => {
      try {
        await admin.query('DELETE FROM repos WHERE id = $1', [id]);
      } finally {
        await admin.end();
      }
    },
  };
}

/** Deletes a demo scope and everything under it, as the admin principal. */
async function purge(sessionId: string): Promise<void> {
  const admin = new Client({
    connectionString: process.env.CORTEX_DSN,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    for (const table of ['claims', 'intents', 'findings', 'action_ledger', 'agents']) {
      await admin.query(`DELETE FROM ${table} WHERE repo_id = $1`, [sessionId]);
    }
    await admin.query('DELETE FROM repos WHERE id = $1', [sessionId]);
  } finally {
    await admin.end();
  }
}

describe('the demo pool is a plane of its own', () => {
  /**
   * U14's named silent break, asserted rather than described. `getPool()` read one
   * variable, so a write Lambda wired up by pointing `CORTEX_DSN` at a write principal
   * would have handed the same privileges to every other function in the deployment.
   * The planes must come from different variables and connect as different SQL users.
   */
  it('connects as cortex_demo, and the write plane does not', async () => {
    const demo = await getPool('demo').query<{ who: string }>('SELECT current_user AS who');
    expect(demo.rows[0]?.who).toBe('cortex_demo');

    const write = await getPool().query<{ who: string }>('SELECT current_user AS who');
    expect(write.rows[0]?.who).not.toBe('cortex_demo');
  });

  it('hands back a different pool per plane', () => {
    expect(getPool('demo')).not.toBe(getPool('write'));
  });
});

describe('the session scope is bound, not interpolated — invariant 7', () => {
  it('scopes the transaction and releases the connection unscoped', async () => {
    const session = await createDemoSession();

    try {
      const scoped = await withRetry(
        async (client) => {
          const { rows } = await client.query<{ n: string }>(
            'SELECT count(*)::INT AS n FROM repos WHERE id = $1',
            [session.sessionId],
          );
          return Number(rows[0]?.n ?? 0);
        },
        { plane: 'demo', demoSession: session.sessionId },
      );
      expect(scoped).toBe(1);

      // The same pool, no scope. If `set_config` were not transaction-local, a pooled
      // connection would carry the previous visitor's scope into this query.
      const leaked = await getPool('demo').query<{ n: string }>(
        'SELECT count(*)::INT AS n FROM repos WHERE id = $1',
        [session.sessionId],
      );
      expect(Number(leaked.rows[0]?.n ?? 0)).toBe(0);
    } finally {
      await purge(session.sessionId);
    }
  });

  /**
   * The failure this is written about: `SET cortex.demo_session = '${id}'` with `id`
   * arriving from a browser. Under interpolation this statement ends the SET and runs a
   * second one; under a bind parameter it is one uninteresting string that matches no
   * scope. `claims` must still exist afterwards either way — that is the assertion.
   */
  it('treats a hostile session id as a value and not as SQL', async () => {
    const hostile = "not-a-uuid'; DROP TABLE claims; --";

    await expect(
      withRetry(async (client) => client.query('SELECT 1'), {
        plane: 'demo',
        demoSession: hostile,
      }),
    ).resolves.toBeDefined();

    const { rows } = await getPool().query<{ n: string }>(
      "SELECT count(*)::INT AS n FROM [SHOW TABLES] WHERE table_name = 'claims'",
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
  });
});

describe('creating a session — invariant 6', () => {
  it('creates a live, expiring demo scope that the demo principal can see', async () => {
    const session = await createDemoSession();

    try {
      expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const admin = new Client({
        connectionString: process.env.CORTEX_DSN,
        connectionTimeoutMillis: 10_000,
      });
      await admin.connect();
      try {
        const { rows } = await admin.query<{ demo_expires_at: Date | null }>(
          'SELECT demo_expires_at FROM repos WHERE id = $1',
          [session.sessionId],
        );
        // NULL here would mean a real repository, which is the one thing a demo scope
        // must never be: `04` §3's whole boundary is this column being non-NULL.
        expect(rows[0]?.demo_expires_at).not.toBeNull();
      } finally {
        await admin.end();
      }
    } finally {
      await purge(session.sessionId);
    }
  });
});

describe('reading a session — invariant 5', () => {
  it('carries WHERE repo_id on every statement it issues', () => {
    for (const sql of [
      DEMO_CLAIMS_SQL,
      DEMO_INTENTS_SQL,
      DEMO_FINDINGS_SQL,
      DEMO_LEDGER_SQL,
      DEMO_ROW_COUNT_SQL,
    ]) {
      expect(sql).toMatch(/repo_id\s*=\s*\$1/);
    }
  });

  /**
   * `07` §2 groups the memory panel by `03` §2's four tiers, and procedural was the one
   * with no data source until U16 — `demoState` queried three tables and the changefeed
   * watched three. A panel with an always-empty fourth group reads as a broken tier rather
   * than as a quiet omission.
   */
  it('returns all four memory tiers, procedural included', async () => {
    const session = await createDemoSession();
    try {
      const state = await demoState(session.sessionId);
      expect(state).not.toBeNull();
      expect(state?.claims).toEqual([]);
      expect(state?.intents).toEqual([]);
      expect(state?.findings).toEqual([]);
      expect(state?.ledger).toEqual([]);
    } finally {
      await purge(session.sessionId);
    }
  });

  /**
   * `05` §5: the current mode and the reason for it MUST be readable by the SPA, so the
   * interface can render a degraded state truthfully instead of discovering it through a
   * failed request. It must also not claim replayed reasoning, which is `07` §4's wording
   * and is not true of this deployment — see `docs/SPEC-DELTA.md`.
   */
  it('reports a mode the page can display, and does not claim cached reasoning', async () => {
    const session = await createDemoSession();
    try {
      const state = await demoState(session.sessionId);
      expect(state?.mode.name).toBeTruthy();
      expect(state?.mode.reason).toBeTruthy();
      // `07` §4's prescribed line is "agent reasoning is cached, all database behaviour is
      // live". The first half is false here — this scenario performs no model reasoning —
      // so the assertion is that the page never claims it, not that the word is absent:
      // the honest wording says reasoning is *not* replayed, and must be free to say so.
      expect(state?.mode.reason).not.toMatch(/reasoning is cached/i);
      expect(state?.mode.reason).toMatch(/no model reasoning/i);
    } finally {
      await purge(session.sessionId);
    }
  });

  it('does not show one session another session rows', async () => {
    const a = await createDemoSession();
    const b = await createDemoSession();

    try {
      await withRetry(
        async (client) => {
          await client.query(
            `INSERT INTO findings (repo_id, fact, embedding)
             VALUES ($1, 'session A wrote this', $2::VECTOR)`,
            [a.sessionId, `[${new Array(1024).fill(0).join(',')}]`],
          );
        },
        { plane: 'demo', demoSession: a.sessionId },
      );

      const seenByA = await demoState(a.sessionId);
      expect(seenByA?.findings.map((f) => f.fact)).toContain('session A wrote this');

      const seenByB = await demoState(b.sessionId);
      expect(seenByB?.findings).toHaveLength(0);
    } finally {
      await purge(a.sessionId);
      await purge(b.sessionId);
    }
  });

  it('reports the session row budget so a degraded state can be rendered', async () => {
    const session = await createDemoSession();
    try {
      const state = await demoState(session.sessionId);
      expect(state?.rows.cap).toBeGreaterThan(0);
      expect(state?.rows.remaining).toBe(state!.rows.cap - state!.rows.used);
    } finally {
      await purge(session.sessionId);
    }
  });

  it('returns nothing at all for a session that is not a live demo scope', async () => {
    // A real repository's own id, offered as though it were a session. This is the case
    // `04` §3 turns on and the one a buggy or compromised demo path produces.
    const real = await realRepository();
    try {
      expect(await demoState(real.id)).toBeNull();
    } finally {
      await real.drop();
    }
  });
});

describe('the demo HTTP surface — invariant 8', () => {
  it('creates a session anonymously, with no credential anywhere in the exchange', async () => {
    const response = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as { sessionId: string };
    try {
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body).not.toMatch(/postgresql:\/\/|sslmode|password/i);
    } finally {
      await purge(body.sessionId);
    }
  });

  /**
   * `05` §5: a request carrying a credential-shaped field MUST be **rejected rather
   * than honoured**. Silently ignoring the field is not enough — the rule exists so that
   * the field never appears to work, because the moment it appears to work somebody
   * pastes a live key into a stranger's web form.
   */
  it.each([
    { dsn: 'postgresql://user:pw@host/db' },
    { apiKey: 'sk-live-whatever' },
    { aws_role_arn: 'arn:aws:iam::1:role/x' },
    { model_override: { token: 'x' } },
  ])('rejects a request carrying a credential-shaped field: %o', async (body) => {
    const response = await handleDemoRequest({ method: 'POST', path: '/demo/session', body });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.stringMatching(/credential/i) });
  });

  /**
   * THE QUERY STRING IS A FIELD TOO, AND IT WAS NOT BEING SCANNED.
   *
   * Found by `/check` on 2026-08-13 (V40). The refusal above read `request.body` and nothing
   * else, while `infra/lambda/demo.ts` parses **every** query parameter and hands it to the
   * handler — so on the deployed API a credential on the query string was ignored and the
   * request honoured with a 200. `05` §5 says "in any field, under any name, on any path", and
   * the rule's whole point is that the field must never *appear to work*.
   *
   * Nothing leaked: the parameter was dropped, not stored or logged. What failed was
   * "rejected rather than honoured", which is the half of the rule that exists precisely
   * because silently ignoring a credential looks, to whoever pasted it, like acceptance.
   *
   * These cases carry no session id on purpose. The refusal happens before routing, so a
   * `400` here proves the scan ran rather than that some later handler objected — an
   * unscanned request would fall through to the route's own "a session id is required",
   * which is also a 400 and would have made a weaker assertion pass.
   */
  it.each([
    // The same fixture string the body cases above use, and reused rather than varied on
    // purpose: it is already declared in `scripts/gate-mechanical.sh`'s placeholder inventory,
    // so this adds no new credential-shaped literal to the history that check scans. Writing a
    // fresh one here is what the hook blocked on the first attempt at this commit.
    { method: 'GET', route: '/demo/state', query: { dsn: 'postgresql://user:pw@host/db' } },
    { method: 'GET', route: '/demo/state', query: { note: 'sslmode=verify-full' } },
    { method: 'POST', route: '/demo/run', query: { api_key: 'sk-live-whatever' } },
    { method: 'GET', route: '/demo/sql-log', query: { aws_role_arn: 'arn:aws:iam::1:role/x' } },
  ])('rejects a credential on the query string: %o', async ({ method, route, query }) => {
    const response = await handleDemoRequest({ method, path: route, query });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: string; field?: string };
    expect(body).toMatchObject({ error: expect.stringMatching(/credential/i) });
    // Named, so the SPA can say which field was refused rather than which request.
    expect(body.field).toMatch(/^query\./);
  });

  /**
   * The non-vacuity guard for the four above. `session` is the one query parameter this
   * surface legitimately takes, it is a public ephemeral identifier the server minted, and
   * `CREDENTIAL_KEY` deliberately omits it. A scan that refused it would take the demo down.
   */
  it('still accepts the one query parameter it is supposed to take', async () => {
    const response = await handleDemoRequest({
      method: 'GET',
      path: '/demo/state',
      query: { session: '00000000-0000-4000-8000-000000000000' },
    });

    // 404 because that session does not exist — the point is that it reached the route at
    // all instead of being refused as a credential.
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toMatch(/credential/i);
  });

  it('answers an unknown route without leaking what else exists', async () => {
    const response = await handleDemoRequest({ method: 'GET', path: '/demo/../etc/passwd' });
    expect(response.statusCode).toBe(404);
  });

  it('serves state for a session over the route the SPA will use', async () => {
    const created = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
    const { sessionId } = JSON.parse(created.body) as { sessionId: string };

    try {
      const response = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: sessionId },
      });
      expect(response.statusCode).toBe(200);

      const state = JSON.parse(response.body) as { claims: unknown[]; rows: { cap: number } };
      expect(state.claims).toEqual([]);
      expect(state.rows.cap).toBeGreaterThan(0);
    } finally {
      await purge(sessionId);
    }
  });

  it('does not accept a session the caller is not entitled to invent', async () => {
    const real = await realRepository();
    try {
      const response = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: real.id },
      });

      // Not an error page: `04` §5 invariant 1. A session that is not a live demo scope
      // is simply not found, and the SPA offers a new one.
      expect(response.statusCode).toBe(404);
    } finally {
      await real.drop();
    }
  });
});
