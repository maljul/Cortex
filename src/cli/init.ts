/**
 * `cortex init` — U2. `05` §2, `03` §2.
 *
 * Brings a cluster from empty to working: create the SQL roles the migration expects,
 * write their connection strings into `.env`, apply the schema, then prove the privilege
 * planes by attempting statements against them.
 *
 * **It does not provision a cluster, and no line here or in any doc may say it does.**
 * `05` §2's table says "provision a free cluster with ccloud". `init` is
 * provisioning-optional instead: it takes an operator DSN in `CORTEX_DSN` — the one a user
 * pastes out of the Cloud Console or out of `ccloud quickstart` — and does everything after
 * that. The deviation is `docs/SPEC-DELTA.md`'s.
 *
 * **`ccloud` is invoked here since 2026-08-18, and only to ask whether it exists.**
 * `src/cli/ccloud.ts` runs `ccloud version` so the missing-DSN path can name the step this
 * machine actually needs next. That is the whole of the integration: nothing in this project
 * creates a cluster, creates a SQL user, or reads a connection string out of ccloud. The
 * sentence above about provisioning is therefore still exactly true, and must stay so.
 *
 * Three rules make a second run safe, and they are the done-when:
 *   - a role that exists is reported and left alone. No password is ever rotated, because
 *     rotating one silently invalidates every `.env` on every other machine.
 *   - a `.env` key that exists is left alone. `.env` is append-only here (`env-file.ts`).
 *   - the migration is idempotent already (U1), so applying it twice is not a second act.
 *
 * **Nothing in this file prints a credential.** Key names, character counts and verdicts
 * only, which is `scripts/env-doctor.mts`'s convention and `05` §2's rule. Passwords are
 * bound as parameters, never interpolated, so no password ever reaches a SQL string.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

import { detectCcloud, operatorDsnGuidance } from './ccloud.js';
import { appendMissingKeys, readEnvFile } from './env-file.js';
import { statement } from './probes.js';
import { deriveRoles } from './roles.js';
import { splitStatements } from './statements.js';

/** CockroachDB's SQLSTATE for insufficient privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

export interface RoleReport {
  role: string;
  existed: boolean;
  created: boolean;
  envKey: string;
  envKeyPresent: boolean;
  envKeyAppended: boolean;
}

export interface CheckReport {
  check: string;
  verdict: 'PASS' | 'FAIL';
  detail: string;
}

export interface InitReport {
  command: 'init';
  ok: boolean;
  rolesCreated: number;
  envKeysAppended: number;
  roles: RoleReport[];
  schema: { file: string; total: number; applied: number; failed: number };
  verification: CheckReport[];
  problems: string[];
}

export interface InitOptions {
  repoRoot: string;
  /** Human-readable progress. `--json` silences it so stdout carries only the report. */
  log: (line: string) => void;
}

/**
 * A URL-safe password, 32 characters of 192 random bits.
 *
 * base64url on purpose. `process.loadEnvFile` truncates a value at an unquoted `#`
 * (`scripts/check-db.mts` says so in its own error message), and a `+` or `/` inside the
 * userinfo section of a DSN is a second way to be wrong later. base64url has neither.
 */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/** `CORTEX_READER_DSN` from `cortex_reader`, computed rather than looked up. */
export function envKeyForRole(role: string): string {
  const suffix = role.startsWith('cortex_') ? role.slice('cortex_'.length) : role;
  return `CORTEX_${suffix.toUpperCase()}_DSN`;
}

export async function roleExists(client: Client, role: string): Promise<boolean> {
  const { rows } = await client.query(statement('role_exists'), [role]);
  return rows.length > 0;
}

/**
 * Creates one role with the given password.
 *
 * The password is a BIND PARAMETER. Interpolating it would work until the first password
 * containing a quote and would put a credential into a SQL string that any statement log
 * could carry. The role name cannot be bound — it is an identifier — so it is validated
 * against the identifier grammar and quoted; it comes from `sql/001_init.sql`, which is a
 * committed file rather than anything an agent or a caller supplies (invariant 7).
 */
export async function createRole(client: Client, role: string, password: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`refusing to create a role whose name is not a plain identifier: ${role}`);
  }
  await client.query(`CREATE USER "${role}" WITH PASSWORD $1`, [password]);
}

/** The operator's DSN with a different principal on it. Never logged. */
export function composeDsn(operatorDsn: string, role: string, password: string): string {
  const url = new URL(operatorDsn);
  url.username = role;
  url.password = password;
  return url.toString();
}

interface Attempt {
  allowed: boolean;
  code: string;
  message: string;
}

/**
 * Runs one statement on its own connection and reports what happened.
 *
 * Writes go inside a transaction that is always rolled back, so the case this exists to
 * catch — a write that unexpectedly succeeds — leaves no row behind. Shape borrowed from
 * `test/privilege-planes.test.ts`, deliberately: the CLI and the suite must mean the same
 * thing by "the reader cannot write".
 */
async function attempt(dsn: string, sql: string, write: boolean): Promise<Attempt> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    if (write) await client.query('BEGIN');
    await client.query(sql);
    if (write) await client.query('ROLLBACK');
    return { allowed: true, code: '', message: '' };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { allowed: false, code: failure.code ?? '', message: failure.message ?? '' };
  } finally {
    await client.end().catch(() => {});
  }
}

async function principal(dsn: string): Promise<string> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const { rows } = await client.query(statement('current_principal'));
    return (rows[0] as { who: string }).who;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * `04` §3's claims about the two planes an application opens, as statements to attempt.
 *
 * Keyed by role rather than derived from it, because "the reader holds no write verb" is a
 * fact about that plane's purpose and cannot be read off its name. A role the migration
 * adds later gets the identity check and is reported as having no privilege assertions,
 * rather than silently reported as verified.
 */
const PLANE_CHECKS: Record<
  string,
  Array<{ name: string; statement: string; write: boolean; expect: 'allowed' | 'refused' }>
> = {
  cortex_reader: [
    { name: 'reads the six tables', statement: 'probe_read', write: false, expect: 'allowed' },
    { name: 'is refused a write', statement: 'probe_write', write: true, expect: 'refused' },
  ],
  cortex_writer: [
    { name: 'writes inside a rolled-back transaction', statement: 'probe_write', write: true, expect: 'allowed' },
    { name: 'is refused DDL', statement: 'probe_ddl', write: true, expect: 'refused' },
  ],
};

export async function init(options: InitOptions): Promise<InitReport> {
  const { repoRoot, log } = options;
  const schemaPath = resolve(repoRoot, 'sql/001_init.sql');
  const envPath = resolve(repoRoot, '.env');

  const report: InitReport = {
    command: 'init',
    ok: false,
    rolesCreated: 0,
    envKeysAppended: 0,
    roles: [],
    schema: { file: 'sql/001_init.sql', total: 0, applied: 0, failed: 0 },
    verification: [],
    problems: [],
  };

  const operatorDsn = process.env.CORTEX_DSN;
  if (operatorDsn === undefined || operatorDsn.trim() === '') {
    // Both routes to a connection string, and which of them this machine can take —
    // `src/cli/ccloud.ts`. This was one static sentence naming only the Console until
    // 2026-08-18; the ccloud route is faster for someone already in a terminal, and the
    // detection is what lets the instructions name the step they actually need next.
    report.problems.push(operatorDsnGuidance(detectCcloud()));
    return report;
  }
  if (!existsSync(schemaPath)) {
    report.problems.push(`no migration at ${schemaPath}`);
    return report;
  }

  const schemaSql = readFileSync(schemaPath, 'utf8');
  const roles = deriveRoles(schemaSql);
  log(`roles      derived from sql/001_init.sql: ${roles.length}`);

  const operator = new Client({ connectionString: operatorDsn, connectionTimeoutMillis: 10_000 });
  try {
    await operator.connect();
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    report.problems.push(
      `could not connect as the operator (CORTEX_DSN): ${failure.code ?? 'no SQLSTATE'} — ` +
        `${failure.message ?? 'no message'}`,
    );
    return report;
  }

  try {
    // ---- a. ROLES -----------------------------------------------------------------
    const present = new Set(readEnvFile(envPath).map((entry) => entry.key));
    const additions: Array<{ key: string; value: string }> = [];

    for (const role of roles) {
      const envKey = envKeyForRole(role);
      const existed = await roleExists(operator, role);
      const entry: RoleReport = {
        role,
        existed,
        created: false,
        envKey,
        envKeyPresent: present.has(envKey),
        envKeyAppended: false,
      };

      if (!existed) {
        const password = generatePassword();
        await createRole(operator, role, password);
        entry.created = true;
        report.rolesCreated += 1;
        const dsn = composeDsn(operatorDsn, role, password);
        // Held in memory for the verification phase below. The only place it is written
        // is .env, and only if that key is absent.
        process.env[envKey] = dsn;
        if (!entry.envKeyPresent) additions.push({ key: envKey, value: dsn });
      } else if (!entry.envKeyPresent) {
        report.problems.push(
          `${role} already exists on the cluster but ${envKey} is not in .env. Its password ` +
            'cannot be recovered and this command will not rotate one, because rotating ' +
            'invalidates every other machine holding it. Either reset that role\'s password in ' +
            `the Cloud Console and add ${envKey} to .env yourself, or DROP the role and re-run.`,
        );
      }

      report.roles.push(entry);
    }

    if (report.problems.length > 0) return report;

    const appended = appendMissingKeys(envPath, additions);
    report.envKeysAppended = appended.length;
    for (const entry of report.roles) entry.envKeyAppended = appended.includes(entry.envKey);

    for (const entry of report.roles) {
      const state = entry.created ? 'CREATED' : 'exists';
      const keyState = entry.envKeyAppended
        ? 'appended to .env'
        : entry.envKeyPresent
          ? 'already in .env'
          : 'not in .env';
      log(`  ${entry.role.padEnd(16)} ${state.padEnd(8)} ${entry.envKey.padEnd(20)} ${keyState}`);
    }

    // ---- b. SCHEMA ----------------------------------------------------------------
    //
    // Driven here rather than by spawning `npm run sql`: without --stop-on-error that
    // script reports failures and exits 0, and `init` has to own its own failure
    // semantics. A failed statement is exit 1 with the SQLSTATE.
    const statements = splitStatements(schemaSql);
    report.schema.total = statements.length;
    const startedAt = Date.now();

    for (const statement of statements) {
      try {
        await operator.query(statement.sql);
        report.schema.applied += 1;
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        report.schema.failed += 1;
        report.problems.push(
          `sql/001_init.sql statement ${statement.index} (line ${statement.line}) failed: ` +
            `${failure.code ?? 'no SQLSTATE'} — ${failure.message ?? 'no message'}`,
        );
        return report;
      }
    }

    log(
      `schema     sql/001_init.sql  ${report.schema.applied}/${report.schema.total} statements applied in ` +
        `${Date.now() - startedAt}ms`,
    );

    // ---- c. VERIFY ----------------------------------------------------------------
    //
    // By attempting the statement, never by reading a catalogue. V9 is why: SHOW GRANTS
    // answered a narrow question truthfully while all three accounts held admin through a
    // role membership the question never asked about.
    log('verification (every line below is a statement the cluster answered, not a grant read)');

    for (const role of roles) {
      const envKey = envKeyForRole(role);
      const dsn = process.env[envKey];

      if (dsn === undefined || dsn.trim() === '') {
        report.verification.push({ check: `${role} plane`, verdict: 'FAIL', detail: `${envKey} is not set` });
        continue;
      }

      try {
        const who = await principal(dsn);
        report.verification.push({
          check: `${envKey} connects as ${role}`,
          verdict: who === role ? 'PASS' : 'FAIL',
          detail: who === role ? role : `connected as ${who}`,
        });
        if (who !== role) continue;
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        report.verification.push({
          check: `${envKey} connects as ${role}`,
          verdict: 'FAIL',
          detail: `${failure.code ?? 'no SQLSTATE'} — ${failure.message ?? 'no message'}`,
        });
        continue;
      }

      for (const check of PLANE_CHECKS[role] ?? []) {
        const result = await attempt(dsn, statement(check.statement), check.write);
        const passed =
          check.expect === 'allowed'
            ? result.allowed
            : !result.allowed && result.code === INSUFFICIENT_PRIVILEGE;
        report.verification.push({
          check: `${role}: ${check.name}`,
          verdict: passed ? 'PASS' : 'FAIL',
          detail: result.allowed ? 'allowed' : `refused ${result.code}`,
        });
      }
    }

    for (const check of report.verification) {
      log(`  ${check.check.padEnd(56)} ${check.verdict}  ${check.detail}`);
    }

    const failures = report.verification.filter((check) => check.verdict === 'FAIL');
    for (const failure of failures) {
      report.problems.push(`verification failed: ${failure.check} (${failure.detail})`);
    }

    report.ok = report.problems.length === 0;
    return report;
  } finally {
    await operator.end().catch(() => {});
  }
}
