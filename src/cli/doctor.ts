/**
 * `cortex doctor` — `05` §2.
 *
 * Four questions, each answered by doing rather than by reading a setting:
 *   1. what does `.env` carry (key names and character counts — never a value)
 *   2. can each plane connect, and as whom
 *   3. does the cluster have the tables `sql/001_init.sql` creates
 *   4. **does a connection string appear in a tracked file**
 *
 * The fourth is `05` §6's rule, verbatim: "No credential is ever read from, or written to,
 * the repository. `cortex doctor` MUST fail loudly if a DSN appears in a tracked file."
 * Loudly means exit 1, and the offender is reported as `path:line` with the matched text
 * withheld — printing it would be the leak the check exists to prevent.
 *
 * The placeholder connection strings this repository is supposed to contain (`.env.example`,
 * two test fixtures, a `curl` recipe in the docs, an error message) are excused, and the
 * inventory of them is READ FROM `scripts/gate-mechanical.sh` rather than copied here. One
 * inventory, in the file whose comment explains why naming exact strings is narrower than
 * matching a shape. A second copy would drift, and a drifted allowlist is either a false
 * alarm nobody reads or a hole nobody sees.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

import { detectCcloud } from './ccloud.js';
import { readEnvFile } from './env-file.js';
import { envKeyForRole } from './init.js';
import { statement } from './probes.js';
import { deriveRoles, deriveTables } from './roles.js';

/**
 * A URL carrying a userinfo section — the shape a DSN has and a bare hostname does not.
 *
 * Written with the slashes escaped so this line is not itself a match: the check must be
 * able to scan its own source. `scripts/gate-mechanical.sh` solves the same problem by
 * anchoring an exemption to its own assignment, and says why in a comment there.
 */
const CONNECTION_STRING = /[a-z][a-z0-9+.-]*:\/\/[^\s'"/@]+:[^\s'"/@]+@/i;

/** Files whose contents are not text worth scanning line by line. */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

export interface CheckReport {
  check: string;
  verdict: 'PASS' | 'FAIL' | 'INFO';
  detail: string;
}

export interface DoctorReport {
  command: 'doctor';
  ok: boolean;
  env: Array<{ key: string; chars: number }>;
  planes: CheckReport[];
  schema: CheckReport[];
  /**
   * Optional tooling this machine may or may not have. **Never contributes to `problems`**,
   * which is what keeps `ok` meaning "this cluster is healthy" rather than "this laptop is
   * fully equipped" — a machine with no ccloud is a supported machine.
   */
  tooling: CheckReport[];
  tracked: { filesScanned: number; hits: string[] };
  problems: string[];
}

/**
 * The blessed placeholder strings, parsed out of `scripts/gate-mechanical.sh`.
 *
 * An empty result would excuse nothing rather than everything — the opposite failure mode
 * from the shell script's `grep -vF ''`, and the safe direction — but it still means the
 * marker moved, so it is reported as a problem rather than passed over.
 */
export function placeholderInventory(gateScript: string): string[] {
  const start = gateScript.indexOf('# BEGIN PLACEHOLDER INVENTORY');
  const end = gateScript.indexOf('# END PLACEHOLDER INVENTORY');
  if (start === -1 || end === -1 || end < start) return [];

  return gateScript
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => CONNECTION_STRING.test(line));
}

/**
 * The 1-based lines of `text` that carry a connection string no placeholder excuses.
 *
 * Separated from the file walk so both directions can be asserted without a fixture: a
 * declared placeholder must be excused, and the same string must be caught when it is not
 * declared. `test/cli-init.test.ts` feeds it the inventory's own entries, so the test needs
 * no credential-shaped literal of its own.
 */
export function scanText(text: string, inventory: string[]): number[] {
  const hits: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (!CONNECTION_STRING.test(line)) return;
    if (inventory.some((placeholder) => line.includes(placeholder))) return;
    hits.push(index + 1);
  });
  return hits;
}

/** Tracked files, from git itself rather than from a directory walk that would miss .gitignore. */
function trackedFiles(repoRoot: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((path) => path !== '');
}

export function scanTrackedFiles(repoRoot: string): { filesScanned: number; hits: string[] } {
  const gatePath = resolve(repoRoot, 'scripts/gate-mechanical.sh');
  const inventory = existsSync(gatePath) ? placeholderInventory(readFileSync(gatePath, 'utf8')) : [];
  const hits: string[] = [];
  let filesScanned = 0;

  for (const relative of trackedFiles(repoRoot)) {
    const path = resolve(repoRoot, relative);
    if (!existsSync(path) || statSync(path).size > MAX_SCAN_BYTES) continue;

    const text = readFileSync(path, 'utf8');
    if (text.includes('\0')) continue;
    filesScanned += 1;

    // A line carrying one of the declared placeholders is a false positive, not a leak.
    for (const line of scanText(text, inventory)) hits.push(`${relative}:${line}`);
  }

  return { filesScanned, hits };
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

export interface DoctorOptions {
  repoRoot: string;
  log: (line: string) => void;
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const { repoRoot, log } = options;
  const envPath = resolve(repoRoot, '.env');
  const schemaPath = resolve(repoRoot, 'sql/001_init.sql');

  const report: DoctorReport = {
    command: 'doctor',
    ok: false,
    env: [],
    planes: [],
    schema: [],
    tooling: [],
    tracked: { filesScanned: 0, hits: [] },
    problems: [],
  };

  // ---- .env, as names and lengths -------------------------------------------------
  report.env = readEnvFile(envPath).map((entry) => ({ key: entry.key, chars: entry.value.length }));
  log(`.env       ${report.env.length} key(s) at ${envPath}`);
  for (const entry of report.env) {
    log(`  ${entry.key.padEnd(24)} ${entry.chars === 0 ? 'EMPTY' : `${entry.chars} chars`}`);
  }

  // ---- the planes -----------------------------------------------------------------
  const roles = existsSync(schemaPath) ? deriveRoles(readFileSync(schemaPath, 'utf8')) : [];
  const planes: Array<{ key: string; expect: string | null }> = [
    { key: 'CORTEX_DSN', expect: null },
    ...roles.map((role) => ({ key: envKeyForRole(role), expect: role })),
  ];

  log('planes     (connected, not inferred from a grant)');
  for (const plane of planes) {
    const dsn = process.env[plane.key];
    if (dsn === undefined || dsn.trim() === '') {
      report.planes.push({ check: plane.key, verdict: 'FAIL', detail: 'not set in .env' });
      continue;
    }
    try {
      const who = await principal(dsn);
      const ok = plane.expect === null || who === plane.expect;
      report.planes.push({
        check: plane.key,
        verdict: ok ? 'PASS' : 'FAIL',
        detail: ok ? `connects as ${who}` : `connects as ${who}, expected ${plane.expect}`,
      });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      report.planes.push({
        check: plane.key,
        verdict: 'FAIL',
        detail: `${failure.code ?? 'no SQLSTATE'} — ${failure.message ?? 'no message'}`,
      });
    }
  }
  for (const plane of report.planes) log(`  ${plane.check.padEnd(24)} ${plane.verdict}  ${plane.detail}`);

  // ---- schema drift ---------------------------------------------------------------
  const operatorDsn = process.env.CORTEX_DSN;
  if (existsSync(schemaPath) && operatorDsn !== undefined && operatorDsn.trim() !== '') {
    const expected = deriveTables(readFileSync(schemaPath, 'utf8'));
    const client = new Client({ connectionString: operatorDsn, connectionTimeoutMillis: 10_000 });
    try {
      await client.connect();
      const { rows } = await client.query<{ table_name: string }>(statement('table_inventory'));
      const found = new Set(rows.map((row) => row.table_name));
      for (const table of expected) {
        report.schema.push({
          check: table,
          verdict: found.has(table) ? 'PASS' : 'FAIL',
          detail: found.has(table) ? 'present' : 'MISSING — run `cortex init`',
        });
      }
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      report.schema.push({ check: 'information_schema', verdict: 'FAIL', detail: failure.message ?? 'no message' });
    } finally {
      await client.end().catch(() => {});
    }
    log(`schema     ${report.schema.filter((c) => c.verdict === 'PASS').length}/${report.schema.length} tables present`);
    for (const table of report.schema.filter((c) => c.verdict !== 'PASS')) {
      log(`  ${table.check.padEnd(24)} ${table.verdict}  ${table.detail}`);
    }
  }

  // ---- optional tooling -------------------------------------------------------------
  // INFO, not PASS/FAIL, and deliberately not folded into `problems` below: ccloud is
  // optional in this project and its absence is not a fault to be fixed. Reported because
  // "is ccloud on this machine" is the question `cortex init`'s onboarding text answers,
  // and doctor is where a user checks what their machine has.
  const ccloud = detectCcloud();
  report.tooling.push({
    check: 'ccloud',
    verdict: 'INFO',
    detail: ccloud.installed
      ? `${ccloud.version ?? 'installed, version unknown'} — optional; used for onboarding only`
      : 'not installed — optional; the Cloud Console route needs nothing installed',
  });
  log('tooling    (optional; absence is not a failure)');
  for (const tool of report.tooling) log(`  ${tool.check.padEnd(24)} ${tool.verdict}  ${tool.detail}`);

  // ---- a credential in a tracked file ---------------------------------------------
  report.tracked = scanTrackedFiles(repoRoot);
  log(`tracked    ${report.tracked.filesScanned} file(s) scanned for a connection string`);
  for (const hit of report.tracked.hits) log(`  ${hit}  CONNECTION STRING`);

  for (const hit of report.tracked.hits) {
    report.problems.push(
      `a connection string appears in a tracked file at ${hit}. The text is withheld ` +
        'deliberately. Remove it from the working tree, and remember that `git log -p --all` ' +
        'still carries it — `bash scripts/gate-mechanical.sh --report` scans history.',
    );
  }
  for (const check of [...report.planes, ...report.schema]) {
    if (check.verdict === 'FAIL') report.problems.push(`${check.check}: ${check.detail}`);
  }

  report.ok = report.problems.length === 0;
  return report;
}
