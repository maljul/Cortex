/**
 * PRIVILEGE PLANES — asserted by attempting the write, never by reading a catalogue.
 * spec/04-ARCHITECTURE.md §3, spec/03-MEMORY-MODEL.md §8 test 9.
 *
 * V9 is why this file exists. All three service accounts were members of `admin`,
 * and `SHOW GRANTS ON TABLE claims` showed exactly the narrow grants
 * `sql/001_init.sql` writes — the catalogue answered the narrow question truthfully
 * while the account held everything through a role membership the question never
 * asked about. So nothing here reads a grant. Every claim is made by issuing the
 * statement and requiring the cluster to refuse it.
 *
 * Until now that finding lived only in `docs/verification-log.md`, which does not
 * fail when someone re-grants. This is the regression guard.
 *
 * **The second half IS `03` §8 test 9**, as of 2026-08-11. It used to assert the weaker
 * interim state — "`cortex_demo` holds no privilege at all" — and said so, and said it
 * was written to fail loudly once `04` §3's `[OPEN]` was decided and scoped grants
 * existed. That is what happened: the mechanism is row-level security keyed on a live
 * demo session scope (V24), the old assertions went red, and they were rewritten here
 * rather than relaxed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { vector } from './helpers/vectors.js';

/** CockroachDB's SQLSTATE for insufficient privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

const TABLES = ['repos', 'agents', 'claims', 'intents', 'findings', 'action_ledger'] as const;

interface Attempt {
  allowed: boolean;
  code: string | undefined;
  message: string;
}

/**
 * Runs one statement on its own connection and reports what happened.
 *
 * Writes go inside a transaction that is always rolled back. A refusal throws either
 * way, so the rollback matters only in the case the test exists to catch: if a write
 * unexpectedly succeeds, the assertion fails *and* the row does not survive to
 * confuse the next run.
 */
async function attempt(dsn: string, sql: string, write: boolean): Promise<Attempt> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();

  try {
    if (write) await client.query('BEGIN');
    await client.query(sql);
    if (write) await client.query('ROLLBACK');
    return { allowed: true, code: undefined, message: '' };
  } catch (error) {
    const failure = error as { code?: string; message: string };
    return { allowed: false, code: failure.code, message: failure.message };
  } finally {
    await client.end();
  }
}

async function currentUser(dsn: string): Promise<string> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_user AS who');
    return (rows[0] as { who: string }).who;
  } finally {
    await client.end();
  }
}

/** A syntactically valid write per table, so a refusal is about privilege and nothing else. */
function writeStatement(table: string): string {
  const embedding = `[${vector(1).join(',')}]`;

  switch (table) {
    case 'repos':
      return "INSERT INTO repos (slug) VALUES ('privilege-probe/should-not-exist')";
    case 'agents':
      return `INSERT INTO agents (id, repo_id, kind, session_id)
              VALUES ('privilege-probe', gen_random_uuid(), 'scripted', gen_random_uuid())`;
    case 'claims':
      return `INSERT INTO claims (repo_id, resource_key, intent_id, holder, expires_at)
              VALUES (gen_random_uuid(), 'file:privilege-probe', gen_random_uuid(),
                      'privilege-probe', now() + '1 minute')`;
    case 'intents':
      return `INSERT INTO intents (repo_id, agent_id, statement, resource_keys, embedding)
              VALUES (gen_random_uuid(), 'privilege-probe', 'probe',
                      ARRAY['file:privilege-probe'], '${embedding}')`;
    case 'findings':
      return `INSERT INTO findings (repo_id, fact, embedding)
              VALUES (gen_random_uuid(), 'probe', '${embedding}')`;
    case 'action_ledger':
      return `INSERT INTO action_ledger (repo_id, intent_id, idempotency_key, action, payload_digest)
              VALUES (gen_random_uuid(), gen_random_uuid(), 'privilege-probe', 'probe', 'probe')`;
    default:
      throw new Error(`no write statement for ${table}`);
  }
}

/**
 * Reads a DSN or fails the test with the reason.
 *
 * Deliberately not `it.skip`. A skipped privilege test reports green over an
 * unasserted boundary, which is the exact shape of "N/N passed" standing in for
 * coverage that does not exist.
 */
function dsn(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set in .env, so this privilege plane is unasserted. ` +
        'Set it to a connection string for that principal and re-run. Do not skip ' +
        'this file: an unasserted boundary that reports green is how V9 survived.',
    );
  }
  return value;
}

/**
 * THE WRITE PLANE, WHICH WENT UNASSERTED UNTIL `/check` FOUND IT BLIND (V40).
 *
 * Both other planes have opened with `currentUser` since V15. This one did not, and that is
 * precisely why `src/db/pool.ts` was able to claim for months that `CORTEX_DSN` is
 * `cortex_writer` while it connects as `julian`, a cluster admin. `04` §3's table says
 * `cortex_writer` — "`SELECT`, `INSERT`, `UPDATE`, `DELETE` on the six tables, nothing else" —
 * and the deviation is recorded in `docs/SPEC-DELTA.md`.
 *
 * **This pins the interim truth on purpose, the way the `cortex_demo` half of this file used
 * to.** That half asserted "no privilege at all" and said in as many words that it was written
 * to fail loudly once `04` §3's `[OPEN]` was decided — which is exactly what happened (V24).
 * Same contract here: assert what is, not what the spec wishes, so that moving the plane to
 * `cortex_writer` turns this red and forces the record to move with it. A test asserting the
 * spec's value would simply be red today and teach everyone to ignore it.
 *
 * **The blast radius is measured (V47) and the change is small**, so this is a decision rather
 * than a defect: 35 candidate breakages, 14 surviving refutation, all of them administrative
 * (`sql/001_init.sql` and `scripts/changefeed.mts`). Nothing in `src/`, nothing in `test/` and
 * nothing deployed depends on the extra privilege. What blocks it is that no
 * `CORTEX_WRITER_DSN` exists and that role has never been logged into — V9 exercised it with
 * `SET ROLE` from an admin session, which proves the grants and nothing about the login path.
 */
const WRITE_PLANE_PRINCIPAL = 'julian';

describe('the write plane is not the principal `04` §3 names', () => {
  it(`connects as ${WRITE_PLANE_PRINCIPAL}, the recorded deviation from §3`, async () => {
    expect(
      await currentUser(dsn('CORTEX_DSN')),
      'the write plane changed principal. If this is the move to cortex_writer, update this ' +
        'pin, docs/SPEC-DELTA.md and the comment in src/db/pool.ts together — the point of ' +
        'this assertion is that the three cannot drift apart again.',
    ).toBe(WRITE_PLANE_PRINCIPAL);
  });

  /**
   * The two confusions that would be catastrophic rather than merely over-privileged, and
   * they are asserted separately because the equality above would pass if someone repointed
   * every variable at one credential.
   */
  it('is neither the reader nor the demo principal', async () => {
    const who = await currentUser(dsn('CORTEX_DSN'));
    expect(who).not.toBe('cortex_reader');
    expect(who).not.toBe('cortex_demo');
  });
});

describe('the reader plane reads and cannot write (`04` §3)', () => {
  it('connects as cortex_reader and not as someone else', async () => {
    expect(await currentUser(dsn('CORTEX_READER_DSN'))).toBe('cortex_reader');
  });

  it.each(TABLES)('can SELECT %s', async (table) => {
    const result = await attempt(
      dsn('CORTEX_READER_DSN'),
      `SELECT count(*) FROM ${table}`,
      false,
    );
    expect(result.allowed, `SELECT ${table} was refused: ${result.message}`).toBe(true);
  });

  it.each(TABLES)('cannot INSERT into %s', async (table) => {
    const result = await attempt(dsn('CORTEX_READER_DSN'), writeStatement(table), true);
    expect(result.allowed, `INSERT into ${table} was ALLOWED — the reader can write`).toBe(false);
    expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot UPDATE, DELETE or DROP', async () => {
    const statements = [
      "UPDATE claims SET holder = 'privilege-probe' WHERE resource_key = 'file:nothing-matches'",
      "DELETE FROM claims WHERE resource_key = 'file:nothing-matches'",
      'DROP TABLE findings',
    ];

    for (const sql of statements) {
      const result = await attempt(dsn('CORTEX_READER_DSN'), sql, true);
      expect(result.allowed, `ALLOWED, and it must not be: ${sql}`).toBe(false);
      expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  /**
   * `live_run_budget` is deliberately outside `TABLES` above, because it is not memory —
   * it is `04` §5 brake 2's cost control (U17). The read plane is the agents' recall path
   * and nothing on it reads the budget, so it is not granted there. Asserted rather than
   * left to the absence of a GRANT line: "we did not grant it" and "the cluster refuses
   * it" are different claims, and V9 is the whole reason this file prefers the second.
   */
  it('cannot even SELECT the cost-control table — it is not memory', async () => {
    const result = await attempt(
      dsn('CORTEX_READER_DSN'),
      'SELECT count(*) FROM live_run_budget',
      false,
    );
    expect(result.allowed, 'the read plane reached the LIVE budget, which it has no use for').toBe(
      false,
    );
    expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

/**
 * `03` §8 test 9: "The `cortex_demo` principal cannot write to a `repo_id` that is not a
 * live demo session scope, and cannot read or write another session's rows. Assert
 * against the real principal with its real grants; asserting against application code
 * proves nothing."
 *
 * So nothing below goes through `src/`. Fixtures are made by the write plane, and every
 * assertion is a statement issued on a `cortex_demo` connection.
 *
 * **Read the two refusal shapes**, because they are different and both are correct:
 *   - a row the policy hides is INVISIBLE — SELECT returns nothing, UPDATE and DELETE
 *     report `rowCount` 0. There is no error, and expecting 42501 here would be testing
 *     a misunderstanding of RLS rather than the boundary.
 *   - a row the policy forbids you to CREATE is REFUSED — INSERT raises 42501, because
 *     WITH CHECK is evaluated against the row you are trying to write.
 * A test that only looked for thrown errors would pass while the demo silently read
 * every repository in the cluster.
 */
describe('`03` §8 test 9 — cortex_demo is confined to a live demo session scope', () => {
  const demoDsn = () => dsn('CORTEX_DEMO_DSN');

  /** Repo ids created for this file, torn down in `afterAll`. */
  const scopes: { real: string; sessionA: string; sessionB: string; expired: string } = {
    real: '',
    sessionA: '',
    sessionB: '',
    expired: '',
  };

  /** A `cortex_demo` connection already scoped to one session, as the demo path scopes it. */
  async function asSession<T>(sessionId: string | null, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: demoDsn(), connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      if (sessionId !== null) await client.query(`SET cortex.demo_session = '${sessionId}'`);
      return await run(client);
    } finally {
      await client.end();
    }
  }

  async function tryStatement(
    client: Client,
    sql: string,
    values: unknown[] = [],
  ): Promise<{ allowed: boolean; code?: string | undefined; rowCount: number; message: string }> {
    try {
      const { rowCount } = await client.query(sql, values);
      return { allowed: true, rowCount: rowCount ?? 0, message: '' };
    } catch (error) {
      const failure = error as { code?: string; message: string };
      return { allowed: false, code: failure.code, rowCount: 0, message: failure.message };
    }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: dsn('CORTEX_DSN'), connectionTimeoutMillis: 10_000 });
    await admin.connect();
    try {
      const make = async (slug: string, expires: string | null): Promise<string> => {
        const { rows } = await admin.query(
          `INSERT INTO repos (slug, demo_expires_at) VALUES ($1, $2)
             ON CONFLICT (slug) DO UPDATE SET demo_expires_at = excluded.demo_expires_at
           RETURNING id`,
          [slug, expires],
        );
        return (rows[0] as { id: string }).id;
      };

      scopes.real = await make('test9/real-repository', null);
      scopes.sessionA = await make('test9/demo-session-a', new Date(Date.now() + 3_600_000).toISOString());
      scopes.sessionB = await make('test9/demo-session-b', new Date(Date.now() + 3_600_000).toISOString());
      scopes.expired = await make('test9/demo-expired', new Date(Date.now() - 60_000).toISOString());

      // One finding per scope, so "can this principal see it" has something to answer.
      const embedding = `[${vector(1).join(',')}]`;
      for (const [name, id] of Object.entries(scopes)) {
        await admin.query(
          `INSERT INTO findings (repo_id, fact, embedding) VALUES ($1, $2, '${embedding}')`,
          [id, `test9 fixture: ${name}`],
        );
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterAll(async () => {
    const admin = new Client({ connectionString: dsn('CORTEX_DSN'), connectionTimeoutMillis: 10_000 });
    await admin.connect();
    try {
      const ids = Object.values(scopes).filter(Boolean);
      if (ids.length > 0) {
        await admin.query('DELETE FROM findings WHERE repo_id = ANY($1::UUID[])', [ids]);
        await admin.query('DELETE FROM repos WHERE id = ANY($1::UUID[])', [ids]);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('connects as cortex_demo and not as someone else', async () => {
    expect(await currentUser(demoDsn())).toBe('cortex_demo');
  });

  it('reads nothing at all when the connection names no session', async () => {
    // The failure V5 measured was a forgotten scope filter failing OPEN. This is the
    // same mistake made to fail shut: no session set, nothing visible, on every table.
    await asSession(null, async (client) => {
      for (const table of TABLES) {
        const result = await tryStatement(client, `SELECT count(*)::INT AS n FROM ${table}`);
        expect(result.allowed, `SELECT ${table} errored: ${result.message}`).toBe(true);

        // `Number(...)`: CockroachDB's INT is INT8, which `pg` hands back as a string to
        // avoid losing precision, so `toBe(0)` against the raw value compares '0' to 0.
        const { rows } = await client.query(`SELECT count(*) AS n FROM ${table}`);
        expect(Number((rows[0] as { n: string }).n), `${table} was visible with no session set`).toBe(0);
      }
    });
  }, 60_000);

  it('cannot see a real repository, only its own scope', async () => {
    await asSession(scopes.sessionA, async (client) => {
      const { rows } = await client.query('SELECT repo_id, fact FROM findings');
      const visible = rows as Array<{ repo_id: string; fact: string }>;

      expect(visible.map((r) => r.fact)).toEqual(['test9 fixture: sessionA']);
      expect(
        visible.some((r) => r.repo_id === scopes.real),
        'the demo principal can see real repository memory',
      ).toBe(false);
    });
  }, 60_000);

  it('cannot write to a repo_id that is not a live demo scope', async () => {
    const embedding = `[${vector(1).join(',')}]`;

    await asSession(scopes.sessionA, async (client) => {
      for (const [name, target] of [
        ['a real repository', scopes.real],
        ['an expired demo scope', scopes.expired],
      ] as const) {
        const result = await tryStatement(
          client,
          `INSERT INTO findings (repo_id, fact, embedding) VALUES ($1, 'smuggled', '${embedding}')`,
          [target],
        );
        expect(result.allowed, `INSERT into ${name} was ALLOWED`).toBe(false);
        expect(result.code, `refused for the wrong reason: ${result.message}`).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });
  }, 60_000);

  it('cannot reach a real repository even when the connection names one as its session', async () => {
    // THE assertion in test 9, and the one the other tests cannot make.
    //
    // Every other case here scopes the connection to a legitimate session and then
    // reaches for something else, so the session predicate alone is enough to refuse
    // it — a mutation removing the demo-scope condition entirely left them all green.
    // §3 requires real memory to be unreachable to this principal "even when a statement
    // is wrong", which means the interesting case is the write path being *compromised*
    // or buggy and naming a real repository as its own session.
    //
    // What must hold then: `demo_expires_at IS NOT NULL` is false for a real repository,
    // so the policy refuses regardless of what the connection claims about itself.
    const embedding = `[${vector(1).join(',')}]`;

    await asSession(scopes.real, async (client) => {
      const { rows } = await client.query('SELECT fact FROM findings WHERE repo_id = $1', [
        scopes.real,
      ]);
      expect(rows, 'naming a real repo as the session made real memory readable').toEqual([]);

      const written = await tryStatement(
        client,
        `INSERT INTO findings (repo_id, fact, embedding) VALUES ($1, 'claimed as a session', '${embedding}')`,
        [scopes.real],
      );
      expect(written.allowed, 'naming a real repo as the session made real memory writable').toBe(
        false,
      );
      expect(written.code, `refused for the wrong reason: ${written.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      const updated = await tryStatement(
        client,
        `UPDATE findings SET fact = 'tampered' WHERE repo_id = $1`,
        [scopes.real],
      );
      expect(updated.rowCount, 'naming a real repo as the session allowed an UPDATE').toBe(0);
    });
  }, 60_000);

  it('cannot alter or delete a real repository’s rows', async () => {
    await asSession(scopes.sessionA, async (client) => {
      const updated = await tryStatement(
        client,
        `UPDATE findings SET fact = 'tampered' WHERE repo_id = $1`,
        [scopes.real],
      );
      const deleted = await tryStatement(client, 'DELETE FROM findings WHERE repo_id = $1', [
        scopes.real,
      ]);

      // Invisible, not refused: the rows are outside the policy, so there is nothing to
      // act on. Asserting 42501 here would assert a misreading of RLS.
      expect(updated.rowCount, 'the demo principal UPDATEd real repository memory').toBe(0);
      expect(deleted.rowCount, 'the demo principal DELETEd real repository memory').toBe(0);
    });

    const admin = new Client({ connectionString: dsn('CORTEX_DSN'), connectionTimeoutMillis: 10_000 });
    await admin.connect();
    try {
      const { rows } = await admin.query('SELECT fact FROM findings WHERE repo_id = $1', [
        scopes.real,
      ]);
      expect((rows[0] as { fact: string }).fact).toBe('test9 fixture: real');
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('cannot read or write another live session’s rows', async () => {
    await asSession(scopes.sessionA, async (client) => {
      const { rows } = await client.query('SELECT fact FROM findings WHERE repo_id = $1', [
        scopes.sessionB,
      ]);
      expect(rows, "session A can read session B's rows").toEqual([]);

      const embedding = `[${vector(1).join(',')}]`;
      const written = await tryStatement(
        client,
        `INSERT INTO findings (repo_id, fact, embedding) VALUES ($1, 'cross-session', '${embedding}')`,
        [scopes.sessionB],
      );
      expect(written.allowed, "session A wrote into session B's scope").toBe(false);
      expect(written.code, `refused for the wrong reason: ${written.message}`).toBe(
        INSUFFICIENT_PRIVILEGE,
      );

      const updated = await tryStatement(
        client,
        `UPDATE findings SET fact = 'tampered' WHERE repo_id = $1`,
        [scopes.sessionB],
      );
      expect(updated.rowCount, "session A UPDATEd session B's rows").toBe(0);
    });
  }, 60_000);

  it('can work freely inside its own live scope', async () => {
    // The confinement has to leave a working demo behind it. A policy that refused
    // everything would pass every assertion above and ship a broken product.
    const embedding = `[${vector(1).join(',')}]`;

    await asSession(scopes.sessionA, async (client) => {
      const written = await tryStatement(
        client,
        `INSERT INTO findings (repo_id, fact, embedding) VALUES ($1, 'sandbox write', '${embedding}')`,
        [scopes.sessionA],
      );
      expect(written.allowed, `the demo cannot write its own scope: ${written.message}`).toBe(true);

      const updated = await tryStatement(
        client,
        `UPDATE findings SET fact = 'sandbox edit' WHERE repo_id = $1 AND fact = 'sandbox write'`,
        [scopes.sessionA],
      );
      expect(updated.rowCount).toBe(1);

      const removed = await tryStatement(
        client,
        `DELETE FROM findings WHERE repo_id = $1 AND fact = 'sandbox edit'`,
        [scopes.sessionA],
      );
      expect(removed.rowCount).toBe(1);
    });
  }, 60_000);

  it('loses its scope the moment the session expires', async () => {
    // Reachability is `demo_expires_at > now()`, so an expired scope goes dark without
    // waiting for any cleanup job. Reclamation is housekeeping, not the boundary.
    await asSession(scopes.expired, async (client) => {
      const { rows } = await client.query('SELECT fact FROM findings WHERE repo_id = $1', [
        scopes.expired,
      ]);
      expect(rows, 'an expired demo session can still read its own rows').toEqual([]);
    });
  }, 60_000);

  /**
   * The one row outside a session scope that `cortex_demo` may touch, and the boundary
   * drawn round it — `04` §5 brake 2's counter (U17).
   *
   * It is a real exception to everything above: the budget is global, so its policy is
   * `day = current_date` and not `is_current_demo_scope(...)`. The exception is only
   * defensible while it is one row wide, so that is what is asserted. An earlier day must
   * be invisible, unwritable and unremovable — otherwise a compromised demo path could
   * rewrite history or, worse, delete today's row and reset the brake that governs it.
   */
  it('reaches today’s LIVE budget row and no other day', async () => {
    const admin = new Client({ connectionString: dsn('CORTEX_DSN'), connectionTimeoutMillis: 10_000 });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date - INTERVAL '1 day', 7)
         ON CONFLICT (day) DO UPDATE SET runs_used = 7`,
      );

      await asSession(scopes.sessionA, async (client) => {
        const { rows } = await client.query<{ day: string }>('SELECT day FROM live_run_budget');
        expect(rows.length, 'the demo principal can read a day that is not today').toBeLessThan(2);

        const past = await tryStatement(
          client,
          `INSERT INTO live_run_budget (day, runs_used) VALUES (current_date - INTERVAL '2 days', 99)`,
        );
        expect(past.allowed, 'the demo principal wrote a budget row for another day').toBe(false);
        expect(past.code, `refused for the wrong reason: ${past.message}`).toBe(
          INSUFFICIENT_PRIVILEGE,
        );

        const rewritten = await tryStatement(
          client,
          'UPDATE live_run_budget SET runs_used = 0 WHERE day < current_date',
        );
        expect(rewritten.rowCount, 'the demo principal rewrote an earlier day’s spend').toBe(0);

        // No DELETE grant at all: a principal that can drop today's row can reset the
        // brake that governs it, which would make the cap advisory rather than a cap.
        const wiped = await tryStatement(client, 'DELETE FROM live_run_budget');
        expect(wiped.allowed, 'the demo principal can delete the budget that governs it').toBe(
          false,
        );
        expect(wiped.code, `refused for the wrong reason: ${wiped.message}`).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
    } finally {
      await admin.query(`DELETE FROM live_run_budget WHERE day < current_date`);
      await admin.end();
    }
  }, 60_000);
});
