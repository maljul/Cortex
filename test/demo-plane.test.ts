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
import { randomBytes, randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  handleDemoRequest,
  useEmbedder,
  useRunStarter,
  type RunJob,
} from '../src/demo/api.js';
import { Embedder } from '../src/embed/titan.js';
import { saveFiles } from '../src/memory/shared-state.js';
import { closePool, getPool } from '../src/db/pool.js';
import { withRetry } from '../src/db/retry.js';
import {
  DEMO_CLAIMS_SQL,
  DEMO_FINDINGS_SQL,
  DEMO_INTENTS_SQL,
  DEMO_LEDGER_SQL,
  DEMO_ROW_COUNT_SQL,
  DEMO_SESSION_ROW_CAP,
  FLEET_RUN_ROW_COST,
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
      // live". The first half is still false for what this route describes — an ordinary
      // visitor's run applies a reviewed patch, which is not cached model output — so the
      // assertion is that the page never claims it, not that the word is absent.
      expect(state?.mode.reason).not.toMatch(/reasoning is cached/i);
      expect(state?.mode.reason).toMatch(/no model reasoning/i);
      // And since U24 it must not hint that a LIVE gate exists. Design §7.1: without the
      // capability, the page renders exactly as the public page does.
      expect(state?.mode.reason).not.toMatch(/quota|budget|capability|token/i);
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

    const body = JSON.parse(response.body) as {
      sessionId: string;
      scopes: { cortex: string; naive: string };
    };
    try {
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body).not.toMatch(/postgresql:\/\/|sslmode|password/i);
    } finally {
      // Both scopes since U22, or this suite leaves a `repos` row behind on every run.
      await purge(body.scopes.cortex);
      await purge(body.scopes.naive);
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
    const { sessionId, scopes } = JSON.parse(created.body) as {
      sessionId: string;
      scopes: { cortex: string; naive: string };
    };

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
      await purge(scopes.cortex);
      await purge(scopes.naive);
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

/**
 * U22 — THE ASYNC RUN, AND THE ROUTE SURFACE IT DID NOT GROW.
 *
 * The done-when is "`POST /demo/run` returns inside the gateway ceiling and the whole run arrives
 * over the socket". The ceiling is 30,000ms on this deployment and the run turns out to fit
 * comfortably inside it — 5.9–8.3s in-region against ~50s from a laptop (V51) — so the async shape
 * rests on the stream being the demo and on U24's LIVE mode, not on design §5.1's predicted
 * timeout. `src/demo/run.ts` carries that argument; `npm run gate:async` decides the done-when
 * against the deployed stack, which is the only place a gateway ceiling exists.
 *
 * **What was decided, and why it is a mode rather than a sixth route.** Design §8 already refused
 * to grow `05` §5's route list once — the artifacts are served through `GET /demo/state` "rather
 * than a sixth route" — and design decision 7 keeps the currently deployed page serving until
 * U26's cold read. Changing this route's response shape breaks that page. So `POST /demo/run`
 * keeps its synchronous four-beat behaviour by default and takes the fleet run behind `mode`,
 * which is a fixed choice between two code paths in exactly the sense `arm` already is: two
 * accepted values, neither of which reaches SQL, so invariant 7 is untouched.
 *
 * The last test here is the guard on decision 7 and it is the reason this block runs live.
 */
describe('the fleet run is asynchronous, and the beats route is untouched — U22', () => {
  // The four-beat path embeds for real, against the same Titan model everything else here uses.
  const embedder = new Embedder();
  useEmbedder((text) => embedder.embed(text));

  /** Both of a visitor's scopes, cleaned up together. */
  async function pair(): Promise<{
    sessionId: string;
    scopes: { cortex: string; naive: string };
    purge: () => Promise<void>;
  }> {
    const created = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
    const body = JSON.parse(created.body) as {
      sessionId: string;
      scopes: { cortex: string; naive: string };
    };
    return {
      ...body,
      purge: async () => {
        await purge(body.scopes.cortex);
        await purge(body.scopes.naive);
      },
    };
  }

  /**
   * U23 — DESIGN §8'S ARTIFACT, SERVED WITHOUT A SIXTH ROUTE.
   *
   * "The artifact is the running app, not a diff... Served through `GET /demo/state` rather than a
   * sixth route, so `05` §5's route list does not grow." The tree already lives in the scope's own
   * `demo_shared_state` cell, so this is a projection of a row `demoState` was fetching anyway.
   *
   * The distinction that matters is `null` versus `{}`: a scope that has run nothing has no app,
   * and an empty object would claim it produced one. That is `06` §6's rule — `—` means this arm
   * has no such thing, a bare `0` (or here, an empty tree) is the failure — applied to an artifact
   * rather than to a number.
   */
  it('serves each arm’s finished tree, and says null rather than empty when there is none', async () => {
    const session = await pair();
    try {
      const before = await demoState(session.scopes.cortex);
      expect(before?.files).toBeNull();

      await saveFiles(
        session.scopes.cortex,
        { 'web/index.html': '<main>orders</main>', 'lib/money.js': 'const P = 100;' },
        { plane: 'demo', demoSession: session.scopes.cortex },
      );

      const after = await demoState(session.scopes.cortex);
      expect(after?.files).toEqual({
        'web/index.html': '<main>orders</main>',
        'lib/money.js': 'const P = 100;',
      });

      // Per scope, which is what makes the two iframes two different apps rather than one shown
      // twice. The naive scope has run nothing, so it still has no app.
      const other = await demoState(session.scopes.naive);
      expect(other?.files).toBeNull();
    } finally {
      await session.purge();
    }
  });

  it('creates two live scopes, one per arm, without changing what the deployed page reads', async () => {
    const session = await pair();
    try {
      // Design §4.1: two `repos` rows, so the isolation between the arms is row-level security
      // rather than the incidental "they happen to use different tables" it used to be.
      expect(session.scopes.cortex).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.scopes.naive).toMatch(/^[0-9a-f-]{36}$/);
      expect(session.scopes.naive).not.toBe(session.scopes.cortex);

      // Additive, and this is the whole of decision 7 in one assertion: `sessionId` is still
      // there and is still a live scope, so the deployed page's session → state → run sequence
      // does not know anything changed. It is the cortex scope rather than a third row.
      expect(session.sessionId).toBe(session.scopes.cortex);

      for (const scope of [session.scopes.cortex, session.scopes.naive]) {
        expect(await demoState(scope)).not.toBeNull();
      }
    } finally {
      await session.purge();
    }
  });

  it('hands the fleet run off and returns without performing it', async () => {
    const session = await pair();
    const jobs: { runId: string; scopes: { cortex: string; naive: string } }[] = [];
    useRunStarter(async (job) => void jobs.push(job));

    try {
      const started = Date.now();
      const response = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        body: { session: session.sessionId, mode: 'fleet', naive: session.scopes.naive },
      });
      const elapsed = Date.now() - started;

      // 202: accepted, not done. The distinction is the route's whole point.
      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body) as { runId: string; scopes: unknown };
      expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.scopes).toEqual(session.scopes);

      // Both scopes reach the runner, and the run id the caller was given is the run id the
      // socket will carry. A handoff that renamed either would leave the page listening for a
      // run nobody is performing.
      expect(jobs).toEqual([{ runId: body.runId, scopes: session.scopes }]);

      // Loose on purpose. This asserts the route is not waiting for the work; it is not a
      // latency budget, and it runs on a laptop where every round trip crosses the internet.
      // The number that matters is measured against the deployment by `npm run gate:async`.
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await session.purge();
    }
  });

  it('refuses a fleet run that names only one of the two scopes', async () => {
    const session = await pair();
    useRunStarter(async () => {
      throw new Error('the runner must not be reached without both scopes');
    });

    try {
      const response = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        body: { session: session.sessionId, mode: 'fleet' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: expect.stringMatching(/both|two|naive/i),
      });
    } finally {
      await session.purge();
    }
  });

  it('refuses a fleet run whose naive scope is not a live demo scope', async () => {
    const session = await pair();
    const real = await realRepository();
    useRunStarter(async () => {
      throw new Error('the runner must not be reached with an unowned scope');
    });

    try {
      const response = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        body: { session: session.sessionId, mode: 'fleet', naive: real.id },
      });

      // 404 and not 403: `04` §5 invariant 1 admits no error page, and "that session has
      // expired or never existed" is the same truthful answer `GET /demo/state` gives.
      expect(response.statusCode).toBe(404);
    } finally {
      await real.drop();
      await session.purge();
    }
  });

  /**
   * DECISION 7'S GUARD, AND THE REASON THIS FILE PAYS FOR A LIVE SCENARIO RUN.
   *
   * The deployed page consumes this route's synchronous four-beat response today, and U26's cold
   * read is what retires it. If `mode` ever defaults to `fleet`, or the beats branch is deleted
   * ahead of the new page, that page shows nothing and no other test in this repository notices —
   * `test/scenario.test.ts` calls `runScenario` directly and would stay green.
   */
  it('still performs the four beats synchronously when no mode is given', async () => {
    const session = await pair();
    useRunStarter(async () => {
      throw new Error('the default mode must not reach the fleet runner');
    });

    try {
      const response = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        body: { session: session.sessionId },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        runId?: string;
        steps?: unknown[];
        sql?: { statements: number };
      };
      expect(body.runId).toBeUndefined();
      expect(body.steps?.length).toBeGreaterThan(0);
      expect(body.sql?.statements).toBeGreaterThan(0);
    } finally {
      await session.purge();
    }
  }, 120_000);
});

/**
 * U24 — THE CAPABILITY LINK, RUNG 1 AND RUNG 3, ON THE ROUTE SURFACE.
 *
 * `04` §5's ladder says every limit MUST resolve to a working page, and `05` §5 adds that every
 * rung MUST be expressible "through these routes without an error status". Both are about this
 * file's subject rather than the runner's, so both are asserted here — the gate
 * (`npm run gate:ladder`) forces the limits end to end, and these hold the route's half of the
 * contract where a gate cannot: on the exact shape of what a caller without the capability sees.
 *
 * **No token is written down.** Each case mints one, installs it in the environment for the
 * duration, and restores whatever was there. Only lengths and outcomes are ever asserted.
 */
describe('the LIVE capability, and the rungs the routes own — U24', () => {
  const embedder = new Embedder();
  useEmbedder((text) => embedder.embed(text));

  const originalToken = process.env['LIVE_TOKEN'];

  afterEach(() => {
    if (originalToken === undefined) delete process.env['LIVE_TOKEN'];
    else process.env['LIVE_TOKEN'] = originalToken;
  });

  /**
   * **These tests spend the real counter, because there is only one and its day is the
   * cluster's.** A capability-holding call to `POST /demo/run` takes a LIVE slot, and it takes
   * it whether or not a run follows — that is `authoriseLiveRun`'s stated ordering, "a slot is
   * spent when it is granted rather than when the run succeeds".
   *
   * So the day's value is captured and put back. Without this the suite quietly eats the
   * demo's LIVE budget: no model call is made here, so nothing is spent at Bedrock, but a
   * judge arriving after a few suite runs would find the quota gone for a reason that never
   * cost anybody anything. `test/live-budget.test.ts` takes the same precaution for the same
   * reason.
   */
  let originalCounter: number | null = null;

  async function counter(): Promise<Client> {
    const client = new Client({
      connectionString: process.env.CORTEX_DSN,
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    return client;
  }

  beforeAll(async () => {
    const client = await counter();
    try {
      const { rows } = await client.query<{ runs_used: string }>(
        'SELECT runs_used FROM live_run_budget WHERE day = current_date',
      );
      originalCounter = rows[0] ? Number(rows[0].runs_used) : null;
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const client = await counter();
    try {
      if (originalCounter === null) {
        await client.query('DELETE FROM live_run_budget WHERE day = current_date');
      } else {
        await client.query(
          `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date, $1)
           ON CONFLICT (day) DO UPDATE SET runs_used = $1`,
          [originalCounter],
        );
      }
    } finally {
      await client.end();
    }
  });

  async function pair(): Promise<{
    scopes: { cortex: string; naive: string };
    purge: () => Promise<void>;
  }> {
    const created = await handleDemoRequest({ method: 'POST', path: '/demo/session' });
    const body = JSON.parse(created.body) as { scopes: { cortex: string; naive: string } };
    return {
      scopes: body.scopes,
      purge: async () => {
        await purge(body.scopes.cortex);
        await purge(body.scopes.naive);
      },
    };
  }

  function token(): string {
    const value = randomBytes(32).toString('base64url');
    process.env['LIVE_TOKEN'] = value;
    return value;
  }

  /**
   * THE NON-VACUITY PAIR THIS UNIT TURNS ON.
   *
   * V45 made the query string a scanned field, and `CREDENTIAL_KEY` matches `token`, `auth`,
   * `secret` and `key` among others. Design §7.1 puts the LIVE capability on a query parameter.
   * If that parameter had been named for what it is, the refusal that protects this surface
   * would have refused the capability — 400 on every LIVE link, with nothing failing anywhere
   * else. So the two halves are asserted together: `?live=` routes, `?dsn=` is still refused.
   */
  it('routes a valid ?live= while still refusing a credential on the query string', async () => {
    const value = token();
    const session = await pair();

    try {
      const allowed = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex, live: value },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).not.toMatch(/credential/i);

      const refused = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        // The fixture `scripts/gate-mechanical.sh` already blesses and the cases above already
        // use. Reused rather than varied: a fresh one would be a new credential-shaped literal
        // in this repository's history, which is the rule that has been broken four times.
        query: { session: session.scopes.cortex, dsn: 'postgresql://user:pw@host/db' },
      });
      expect(refused.statusCode).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({ field: 'query.dsn' });
    } finally {
      await session.purge();
    }
  });

  it('never echoes the capability back, and shows the live budget only to a holder', async () => {
    const value = token();
    const session = await pair();

    try {
      const held = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex, live: value },
      });
      const withCapability = JSON.parse(held.body) as { live?: { cap: number; remaining: number } };

      // `05` §5: the current mode and the session's remaining budget MUST be readable by the
      // SPA. The page that can offer a LIVE run is the one that needs rung 1 before the click.
      expect(withCapability.live).toBeDefined();
      expect(typeof withCapability.live?.cap).toBe('number');
      // Compared and forgotten. A capability echoed into a response is a capability in every
      // proxy log between here and the browser.
      expect(held.body).not.toContain(value);

      const anonymous = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex },
      });
      const wrong = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex, live: randomBytes(32).toString('base64url') },
      });

      // Design §7.1: "no error, no hint that a gate exists". A `live` block in every response
      // is that hint, so it is absent — and absent identically for a wrong token, or the block
      // itself would be an oracle telling an attacker when they had guessed right.
      expect(JSON.parse(anonymous.body).live).toBeUndefined();
      expect(JSON.parse(wrong.body).live).toBeUndefined();
      expect(wrong.statusCode).toBe(anonymous.statusCode);
    } finally {
      await session.purge();
    }
  });

  it('authorises LIVE for a holder and hands the runner the capability to re-check', async () => {
    const value = token();
    const session = await pair();
    const jobs: RunJob[] = [];
    useRunStarter(async (job) => void jobs.push(job));

    try {
      const response = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        query: { live: value },
        body: { session: session.scopes.cortex, mode: 'fleet', naive: session.scopes.naive },
      });
      const body = JSON.parse(response.body) as {
        reasoning: { mode: string; reason: string; live?: { cap: number } };
      };

      // The cap is derived and can be 0 when no metered run exists, in which case the honest
      // answer is REPLAY. Either way the route answers, names its mode, and gives a reason.
      expect(response.statusCode).toBe(202);
      expect(['live', 'replay']).toContain(body.reasoning.mode);
      expect(body.reasoning.reason).toBeTruthy();
      expect(body.reasoning.live).toBeDefined();

      // The runner receives an asynchronous invoke it cannot authenticate, so what it is given
      // is the capability itself and not a `live: true` flag — a claim it can turn into a proof
      // by comparing against its own copy of the secret.
      expect(jobs).toHaveLength(1);
      if (body.reasoning.mode === 'live') {
        expect(jobs[0]?.live?.capability).toBe(value);
      } else {
        expect(jobs[0]?.live).toBeUndefined();
      }
    } finally {
      await session.purge();
    }
  });

  it('serves an anonymous caller and a wrong-token caller identically', async () => {
    token();
    const session = await pair();
    useRunStarter(async () => {});

    try {
      const body = { session: session.scopes.cortex, mode: 'fleet', naive: session.scopes.naive };
      const anonymous = await handleDemoRequest({ method: 'POST', path: '/demo/run', body });
      const wrong = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        query: { live: randomBytes(32).toString('base64url') },
        body,
      });

      const a = JSON.parse(anonymous.body) as { reasoning: Record<string, unknown> };
      const w = JSON.parse(wrong.body) as { reasoning: Record<string, unknown> };

      expect(a.reasoning).toEqual(w.reasoning);
      expect(a.reasoning['mode']).toBe('replay');
      // No rung is named, because none fired: an ordinary visitor's run is not a degradation.
      expect(a.reasoning['rung']).toBeUndefined();
      expect(a.reasoning['live']).toBeUndefined();
      expect(JSON.stringify(a.reasoning)).not.toMatch(/quota|budget|token|capability/i);
    } finally {
      await session.purge();
    }
  });

  /**
   * RUNG 3 — `04` §5: "session becomes read-only; its rows, counters and SQL log stay
   * inspectable; a new session is one click", and `05` §5: without an error status.
   *
   * Enforced as a preflight rather than at write time. A cap that fires mid-run leaves a page
   * that was working a second ago showing half a fleet, which is invariant 1's failure wearing
   * a 200.
   */
  it('refuses to start a run a session cannot afford, and leaves it inspectable', async () => {
    const session = await pair();
    useRunStarter(async () => {
      throw new Error('a capped session must not reach the runner');
    });

    try {
      const fill = DEMO_SESSION_ROW_CAP - FLEET_RUN_ROW_COST + 1;
      const admin = new Client({
        connectionString: process.env.CORTEX_DSN,
        connectionTimeoutMillis: 10_000,
      });
      await admin.connect();
      try {
        await admin.query(
          `INSERT INTO findings (repo_id, fact, embedding)
           SELECT $1, 'row budget filler ' || g, $2::VECTOR
             FROM generate_series(1, $3) AS g`,
          [session.scopes.cortex, `[${new Array(1024).fill(0).join(',')}]`, fill],
        );
      } finally {
        await admin.end();
      }

      const refused = await handleDemoRequest({
        method: 'POST',
        path: '/demo/run',
        body: { session: session.scopes.cortex, mode: 'fleet', naive: session.scopes.naive },
      });
      const body = JSON.parse(refused.body) as Record<string, unknown>;

      expect(refused.statusCode).toBe(200);
      expect(body['started']).toBe(false);
      expect(body['rung']).toBe(3);
      expect(String(body['reason'])).toMatch(/one click/i);

      // Everything that made the session worth looking at is still there.
      const state = await handleDemoRequest({
        method: 'GET',
        path: '/demo/state',
        query: { session: session.scopes.cortex },
      });
      expect(state.statusCode).toBe(200);
      expect((JSON.parse(state.body) as { rows: { used: number } }).rows.used).toBeGreaterThanOrEqual(fill);

      const log = await handleDemoRequest({
        method: 'GET',
        path: '/demo/sql-log',
        query: { session: session.scopes.cortex },
      });
      expect(log.statusCode).toBe(200);
    } finally {
      await session.purge();
    }
  }, 60_000);
});
