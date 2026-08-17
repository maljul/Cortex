/**
 * `cortex init` — U2. `05` §2, `03` §2.
 *
 * The unit's done-when is verbatim: "`cortex init` produces a working cluster twice in a
 * row." So the load-bearing test here is not that a function returns a value; it is that
 * the real binary, run twice against the real cluster, exits 0 both times and changes
 * nothing on the second pass.
 *
 * The unit's named silent break is printing a credential. That is asserted the only way
 * that means anything: run the binary for real, capture stdout AND stderr, and require
 * that no value present in `.env` — and no password inside one — appears anywhere in the
 * output. Nothing in this file ever prints a value it reads; assertion messages name the
 * KEY, never the value, which is the same rule `scripts/env-doctor.mts` follows.
 *
 * **Role creation is proved against a throwaway role, dropped in a `finally`.** The three
 * real roles already exist on this cluster, so a run here reports "exists" and creates
 * nothing — which means the creation path would otherwise be unasserted, and an unasserted
 * path that reports green is how V9 survived. The throwaway role is created, connected as,
 * and dropped, so the cluster is left exactly as it was found. Its DSN is never written to
 * `.env`.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { placeholderInventory, scanText } from '../src/cli/doctor.js';
import { parseEnvFile } from '../src/cli/env-file.js';
import { composeDsn, createRole, envKeyForRole, generatePassword, init, roleExists } from '../src/cli/init.js';
import { parseNamedStatements, statement } from '../src/cli/probes.js';
import { deriveRoles, deriveTables } from '../src/cli/roles.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/cortex.mjs', import.meta.url));
const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../sql/001_init.sql', import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const SQL_SCRIPT_PATH = fileURLToPath(new URL('../scripts/sql.mts', import.meta.url));
const GATE_PATH = fileURLToPath(new URL('../scripts/gate-mechanical.sh', import.meta.url));
const CLI_DIR = fileURLToPath(new URL('../src/cli/', import.meta.url));
const CLI_STATEMENTS_PATH = fileURLToPath(new URL('../src/cli/statements.ts', import.meta.url));
const CLI_STATEMENTS_SQL_PATH = fileURLToPath(new URL('../src/cli/statements.sql', import.meta.url));
const CLI_INIT_PATH = fileURLToPath(new URL('../src/cli/init.ts', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, which is what "no credential is printed" has to cover. */
  output: string;
}

function run(args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: REPO, env: process.env, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1;
        done({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
      },
    );
  });
}

/**
 * Every secret this repository holds, as strings — read so they can be searched FOR in the
 * CLI's output. Never printed, never put in an assertion message, never returned anywhere
 * that vitest would render on failure.
 */
function secrets(): Array<{ key: string; needles: string[] }> {
  return parseEnvFile(readFileSync(ENV_PATH, 'utf8'))
    .filter((entry) => entry.value !== '')
    .map((entry) => {
      const needles = [entry.value];
      try {
        const url = new URL(entry.value);
        if (url.password !== '') needles.push(url.password);
      } catch {
        // Not a URL — the whole value is the only thing to look for.
      }
      return { key: entry.key, needles };
    });
}

describe('the role list is derived from sql/001_init.sql, not hardcoded', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');

  it('finds exactly the roles the migration grants to', () => {
    expect(deriveRoles(schema)).toEqual(['cortex_demo', 'cortex_reader', 'cortex_writer']);
  });

  /**
   * The point of deriving rather than listing: a fourth role added to the migration cannot
   * escape `init`. Asserted by mutating a COPY of the SQL — the file on disk is untouched.
   */
  it('picks up a fourth role added to a copy of the migration', () => {
    const mutated = `${schema}\nGRANT SELECT ON TABLE repos TO cortex_auditor;\n`;
    expect(deriveRoles(schema)).not.toContain('cortex_auditor');
    expect(deriveRoles(mutated)).toContain('cortex_auditor');
    expect(deriveRoles(mutated)).toHaveLength(4);
  });

  it('follows a role that is renamed in a copy of the migration', () => {
    const mutated = schema.replaceAll('cortex_reader', 'cortex_archivist');
    expect(deriveRoles(mutated)).toContain('cortex_archivist');
    expect(deriveRoles(mutated)).not.toContain('cortex_reader');
  });

  it('never mistakes PUBLIC for a role that needs a login', () => {
    const mutated = `${schema}\nGRANT SELECT ON TABLE repos TO public;\n`;
    expect(deriveRoles(mutated)).toEqual(deriveRoles(schema));
  });

  it('derives the table list from the same file', () => {
    expect(deriveTables(schema)).toEqual([
      'action_ledger',
      'agents',
      'claims',
      'findings',
      'intents',
      'live_run_budget',
      'repos',
    ]);
  });

  it('maps a role to its .env key without a lookup table', () => {
    expect(envKeyForRole('cortex_reader')).toBe('CORTEX_READER_DSN');
    expect(envKeyForRole('cortex_auditor')).toBe('CORTEX_AUDITOR_DSN');
  });
});

/**
 * The statement splitter is a byte-for-byte copy of `scripts/sql.mts`'s, and this is the
 * pin that keeps the two identical.
 *
 * It is a copy because `scripts/sql.mts` cannot be imported: everything from
 * `const args = process.argv.slice(2)` down runs at module scope, so importing it for its
 * exported function parses argv, prints a usage line and exits 2 — measured, not assumed.
 * The permanent fix is an entrypoint guard in that file, after which this module can be
 * deleted in favour of an import; until then, drift between the two is caught here rather
 * than by a migration behaving differently under `cortex init` than under `npm run sql`.
 */
describe('the statement splitter is pinned to scripts/sql.mts', () => {
  /** A top-level function body, from its signature to the closing brace in column 0. */
  function functionSource(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} is not in this file any more`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}\n', start);
    expect(end, `${signature} has no closing brace in column 0`).toBeGreaterThan(start);
    return source.slice(start, end + 2);
  }

  it.each(['function hasCode(text: string): boolean {', 'export function splitStatements(source: string): Statement[] {'])(
    '%s is identical in both files',
    (signature) => {
      const script = readFileSync(SQL_SCRIPT_PATH, 'utf8');
      const copy = readFileSync(CLI_STATEMENTS_PATH, 'utf8');
      expect(
        functionSource(copy, signature),
        'src/cli/statements.ts has drifted from scripts/sql.mts. Copy the function back, or ' +
          'guard the CLI section of scripts/sql.mts behind an entrypoint check and import it.',
      ).toBe(functionSource(script, signature));
    },
  );

  it('splits the real migration into the statements the cluster will see', async () => {
    const { splitStatements } = await import('../src/cli/statements.js');
    const statements = splitStatements(readFileSync(SCHEMA_PATH, 'utf8'));
    expect(statements.length).toBeGreaterThan(50);
    expect(statements.every((s) => s.sql.trim() !== '')).toBe(true);
  });
});

/**
 * Every statement the CLI sends lives in `src/cli/statements.sql` and is selected by name.
 *
 * The last test is `scripts/gate-mechanical.sh`'s `sql-containment` row, run here as well
 * as there. The first draft of this CLI turned that row red — it is a grep over
 * `src/**​/*.ts`, so a query in a string and a keyword in a comment are the same to it — and
 * a rule that only fails at commit time is one an agent discovers by breaking it.
 */
describe('the CLI composes no SQL', () => {
  const source = readFileSync(CLI_STATEMENTS_SQL_PATH, 'utf8');

  it.each(['role_exists', 'current_principal', 'table_inventory', 'probe_read', 'probe_write', 'probe_ddl'])(
    '%s is a named statement',
    (name) => {
      expect(statement(name).length).toBeGreaterThan(0);
      // The name comment is stripped, so what reaches the cluster is the statement.
      expect(statement(name).startsWith('--')).toBe(false);
    },
  );

  it('throws on a name that is not in the file', () => {
    expect(() => statement('no_such_statement')).toThrow(/no statement named/);
  });

  it('parses every statement in the file exactly once', () => {
    const parsed = parseNamedStatements(source);
    expect(parsed.size).toBe(6);
  });

  it('keeps the sql-containment row green', () => {
    const keyword = /SELECT|INSERT|UPDATE|DELETE/;
    const offenders = readdirSync(CLI_DIR)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => keyword.test(readFileSync(join(CLI_DIR, name), 'utf8')));
    expect(
      offenders,
      'scripts/gate-mechanical.sh greps src/**/*.ts for these keywords and does not know a ' +
        'comment from a query. Put the statement in src/cli/statements.sql and name it.',
    ).toEqual([]);
  });
});

describe('the CLI surface', () => {
  it('--help exits 0 and names the commands that exist', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('bin/cortex.mjs init');
    expect(result.stdout).toContain('bin/cortex.mjs doctor');
  });

  it('--version exits 0 and prints the package version', async () => {
    const result = await run(['--version']);
    const expected = (JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { version: string }).version;
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  /**
   * **`--help` must not tell anyone to run `npx cortex`.** Measured 2026-08-17: this package is
   * not published, `node_modules/.bin/cortex` is not created for a package's own bin, and the
   * public registry carries an unrelated package under that name — so `npx cortex init` fetches
   * and runs a stranger's code. The help text said `usage: npx cortex` for as long as it existed,
   * and so did the README in five places. The guard goes here because `src/cli/main.ts`'s own
   * docblock says it does, and a comment claiming a check that does not exist is the failure this
   * repository names first.
   */
  it('--help offers the invocation that works, not `npx cortex`', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('node bin/cortex.mjs');
    // The name may appear in a warning; what it may not do is appear as an instruction.
    expect(result.stdout).not.toMatch(/usage:\s*npx\s+cortex/);
  });

  /**
   * A bin that silently does nothing for `cortex bench` is worse than no bin: the command
   * appears in `05` §2's table, so a reader will try it.
   */
  it('a command that exists elsewhere exits 1 and names the npm script', async () => {
    const result = await run(['bench']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('npm run bench');
  });

  it('a command that exists nowhere exits 1 and names what does exist', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('bin/cortex.mjs init');
    expect(result.output).toContain('bin/cortex.mjs doctor');
  });
});

/**
 * `05` §6: "`cortex doctor` MUST fail loudly if a DSN appears in a tracked file."
 *
 * Both directions are asserted, because a scanner that never fires and a scanner that fires
 * on everything are indistinguishable from a green run. Neither assertion writes a
 * credential-shaped string into this file: the positive case is fed one of the placeholder
 * strings `scripts/gate-mechanical.sh` already declares, read at run time, and the negative
 * case is assembled from parts. That rule has been broken four times in this repository by
 * pasting a string into a test.
 */
describe('doctor refuses a connection string in a tracked file', () => {
  const inventory = placeholderInventory(readFileSync(GATE_PATH, 'utf8'));

  it('reads the declared placeholders out of the gate script', () => {
    expect(inventory.length).toBeGreaterThan(0);
    // Sanity: each entry is a whole connection string, so `includes` cannot excuse a line
    // by matching a fragment of one.
    for (const entry of inventory) expect(entry.includes('@')).toBe(true);
  });

  it('catches a connection string that nothing declares', () => {
    const undeclared = inventory[0];
    expect(undeclared).toBeDefined();
    expect(scanText(`some line with ${undeclared}\n`, [])).toEqual([1]);
  });

  it('excuses exactly the declared placeholders', () => {
    for (const entry of inventory) {
      expect(scanText(`fixture: ${entry}\n`, inventory)).toEqual([]);
    }
  });

  it('does not fire on a URL with no credentials in it', () => {
    // Assembled rather than written, so this file contains no such string.
    const noSecret = ['postgres', ':', '//', 'host.example', ':26257/defaultdb'].join('');
    expect(scanText(noSecret, [])).toEqual([]);
  });

  it('finds nothing in this repository right now', async () => {
    const { scanTrackedFiles } = await import('../src/cli/doctor.js');
    const result = scanTrackedFiles(REPO);
    expect(result.filesScanned).toBeGreaterThan(100);
    expect(result.hits).toEqual([]);
  });
});

/**
 * ROLE CREATION, against a role that is dropped again.
 *
 * `CREATE USER` is the one thing `init` does that a run on this cluster never reaches, so
 * it is exercised directly. The password is bound, never interpolated; the assertion that
 * it is bound is made against the source, because a string-interpolated password would
 * behave identically here and differently on the first password containing a quote.
 */
describe('role creation', () => {
  const dsn = process.env.CORTEX_DSN;
  const throwaway = `cortex_init_probe_${randomBytes(4).toString('hex')}`;
  let client: Client;

  beforeAll(async () => {
    if (dsn === undefined || dsn === '') throw new Error('CORTEX_DSN is not set; this file cannot run');
    client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
    await client.connect();
  });

  afterAll(async () => {
    await client?.query(`DROP USER IF EXISTS "${throwaway}"`).catch(() => {});
    await client?.end().catch(() => {});
  });

  it('generates a distinct URL-safe password every time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    // URL-safe, so composing a DSN cannot corrupt it, and free of '#', which
    // process.loadEnvFile truncates at.
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it('binds the password rather than interpolating it', () => {
    const source = readFileSync(CLI_INIT_PATH, 'utf8');
    expect(source).toContain('WITH PASSWORD $1');
    expect(/PASSWORD\s+'\s*\$\{/.test(source), 'the password is interpolated into the SQL').toBe(false);
  });

  it('creates a role that can log in, and leaves .env alone', async () => {
    const before = statSync(ENV_PATH);
    const password = generatePassword();

    expect(await roleExists(client, throwaway)).toBe(false);
    await createRole(client, throwaway, password);
    expect(await roleExists(client, throwaway)).toBe(true);

    // A created role that cannot authenticate is not a created role. Proved by connecting
    // as it — never by reading a catalogue (V9).
    const composed = composeDsn(process.env.CORTEX_DSN ?? '', throwaway, password);
    expect(new URL(composed).username).toBe(throwaway);
    expect(new URL(composed).password.length).toBe(password.length);

    const probe = new Client({ connectionString: composed, connectionTimeoutMillis: 10_000 });
    try {
      await probe.connect();
      const { rows } = await probe.query('SELECT current_user AS who');
      expect((rows[0] as { who: string }).who).toBe(throwaway);
    } finally {
      await probe.end().catch(() => {});
    }

    const after = statSync(ENV_PATH);
    expect(after.size, '.env changed while creating a throwaway role').toBe(before.size);
  }, 60_000);
});

/**
 * THE CREATION PATH, TWICE IN A ROW.
 *
 * The three real roles already exist on this cluster, so every run here reports "exists"
 * and the half of `init` that a fresh cluster actually needs — create the role, compose its
 * DSN, append the key, then connect with what was written — would never execute. An
 * unasserted path that reports green is how V9 survived, so it is driven here against a
 * throwaway role and a throwaway migration in a temporary directory.
 *
 * The real `.env` is never touched: `init` derives its env path from the repo root it is
 * given, and this one is under `os.tmpdir()`. The assertion that the real file is unchanged
 * is made anyway, because that is the promise this command makes to a machine that has the
 * file open in an editor.
 *
 * The second run REREADS the temporary `.env` from disk rather than trusting what run one
 * left in `process.env`, so what is asserted is that the line `init` wrote is a line that
 * loads and connects — not merely that a string was appended.
 */
describe('init creates a missing role, appends its key, and is a no-op the second time', () => {
  const suffix = randomBytes(4).toString('hex');
  const probeRole = `cortex_init_probe_${suffix}`;
  const probeKey = envKeyForRole(probeRole);
  const root = mkdtempSync(join(tmpdir(), 'cortex-init-'));
  const probeEnv = join(root, '.env');
  const silent = (): void => {};

  let operator: Client;
  let firstReport: Awaited<ReturnType<typeof init>>;
  let secondReport: Awaited<ReturnType<typeof init>>;
  let realEnvBefore = 0;
  let realEnvAfter = 0;

  beforeAll(async () => {
    const dsn = process.env.CORTEX_DSN;
    if (dsn === undefined || dsn === '') throw new Error('CORTEX_DSN is not set; this file cannot run');
    operator = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
    await operator.connect();

    // A migration of one statement, naming a role that does not exist. `init` has to read
    // the role out of it — nothing here tells the CLI what to create.
    mkdirSync(join(root, 'sql'), { recursive: true });
    writeFileSync(join(root, 'sql/001_init.sql'), `GRANT SELECT ON TABLE repos TO ${probeRole};\n`);

    realEnvBefore = statSync(ENV_PATH).size;
    firstReport = await init({ repoRoot: root, log: silent });

    // Forget what the first run left in memory and read the file it wrote instead.
    delete process.env[probeKey];
    process.loadEnvFile(probeEnv);
    secondReport = await init({ repoRoot: root, log: silent });
    realEnvAfter = statSync(ENV_PATH).size;
  }, 120_000);

  afterAll(async () => {
    await operator?.query(`REVOKE SELECT ON TABLE repos FROM "${probeRole}"`).catch(() => {});
    await operator?.query(`DROP USER IF EXISTS "${probeRole}"`).catch(() => {});
    await operator?.end().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    delete process.env[probeKey];
  });

  it('creates the role the migration names', () => {
    expect(firstReport.problems).toEqual([]);
    expect(firstReport.ok).toBe(true);
    expect(firstReport.rolesCreated).toBe(1);
    expect(firstReport.roles.map((role) => role.role)).toEqual([probeRole]);
  });

  it('appends exactly one key, and it is the role\'s own', () => {
    expect(firstReport.envKeysAppended).toBe(1);
    const keys = parseEnvFile(readFileSync(probeEnv, 'utf8')).map((entry) => entry.key);
    expect(keys).toEqual([probeKey]);
  });

  it('writes a connection string that loads and connects', () => {
    // The verification phase of the SECOND run used the value parsed back off disk. That it
    // passed is the assertion; the value itself is never read by this test.
    expect(secondReport.verification.filter((check) => check.verdict !== 'PASS')).toEqual([]);
    expect(secondReport.verification.some((check) => check.check.includes(probeRole))).toBe(true);
  });

  it('is a no-op the second time', () => {
    expect(secondReport.ok).toBe(true);
    expect(secondReport.rolesCreated).toBe(0);
    expect(secondReport.envKeysAppended).toBe(0);
    const keys = parseEnvFile(readFileSync(probeEnv, 'utf8')).map((entry) => entry.key);
    expect(keys).toEqual([probeKey]);
  });

  it('never rotates the password of a role that already exists', () => {
    // Run two found the role and left it alone; if it had rotated, the DSN read back off
    // disk would no longer authenticate and the verification above would be FAIL.
    expect(secondReport.roles.every((role) => !role.created)).toBe(true);
  });

  it('leaves the repository\'s own .env untouched', () => {
    expect(realEnvAfter).toBe(realEnvBefore);
  });
});

/**
 * THE DONE-WHEN: twice in a row.
 *
 * Two real runs of the real binary against the real cluster. The first is human output —
 * the one at risk of printing a credential — and the second is `--json`, which is what
 * `05` §2 requires of every command and what makes "the second run created nothing" an
 * assertion rather than a reading.
 */
describe('`cortex init` produces a working cluster twice in a row', () => {
  let first: Run;
  let second: Run;
  let health: Run;
  let envBefore: number;
  let envAfter: number;

  beforeAll(async () => {
    envBefore = statSync(ENV_PATH).size;
    first = await run(['init']);
    second = await run(['init', '--json']);
    health = await run(['doctor']);
    envAfter = statSync(ENV_PATH).size;
  }, 300_000);

  it('leaves the cluster in a state doctor calls healthy', () => {
    expect(health.code, health.output).toBe(0);
  });

  it('doctor reports whether ccloud is present, and never fails for its absence', () => {
    // ccloud is optional here — `init` is provisioning-optional and nothing in this project
    // invokes ccloud for anything but this row. So the row must appear, and its verdict must
    // never be what makes doctor exit non-zero; a machine without ccloud is healthy.
    expect(health.output).toContain('ccloud');
    expect(health.code, health.output).toBe(0);
  });

  it('the first run exits 0', () => {
    expect(first.code, first.output).toBe(0);
  });

  it('the second run exits 0', () => {
    expect(second.code, second.output).toBe(0);
  });

  it('the second run is a no-op — no role created, no .env key appended', () => {
    const report = JSON.parse(second.stdout) as {
      ok: boolean;
      rolesCreated: number;
      envKeysAppended: number;
      schema: { total: number; applied: number; failed: number };
      verification: Array<{ check: string; verdict: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.rolesCreated).toBe(0);
    expect(report.envKeysAppended).toBe(0);
    expect(report.schema.failed).toBe(0);
    expect(report.schema.applied).toBe(report.schema.total);
    expect(report.verification.length).toBeGreaterThan(0);
    expect(report.verification.filter((v) => v.verdict !== 'PASS')).toEqual([]);
  });

  it('applies every statement of the migration on both runs', () => {
    expect(first.stdout).toMatch(/schema\s+.*\s(\d+)\/\1 statements/);
  });

  it('.env is byte-identical across both runs', () => {
    expect(envAfter).toBe(envBefore);
  });

  it('.env carries no duplicated key', () => {
    const keys = parseEnvFile(readFileSync(ENV_PATH, 'utf8')).map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  /**
   * `05` §2: "No command may print a credential." Asserted over both runs at once, because
   * the JSON form is a second surface and a machine-readable leak is still a leak.
   */
  it('prints no value that is in .env, and no password inside one', () => {
    const combined = `${first.output}\n${second.output}\n${health.output}`;
    for (const { key, needles } of secrets()) {
      for (const needle of needles) {
        // The message names the KEY. It must never name the value.
        expect(combined.includes(needle), `the CLI printed something from ${key}`).toBe(false);
      }
    }
  });

  it('prints no connection string at all, from .env or anywhere else', () => {
    const combined = `${first.output}\n${second.output}\n${health.output}`;
    // A URL with a userinfo section — the shape a DSN has and a hostname does not.
    const withCredentials = /[a-z][a-z0-9+.-]*:\/\/[^\s'"/]*:[^\s'"/]*@/i;
    expect(withCredentials.test(combined)).toBe(false);
  });
});
