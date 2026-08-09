/**
 * Applies a .sql file to the cluster named by CORTEX_DSN, one statement at a time,
 * printing what each statement actually returned.
 *
 * `sql/000_verify.sql` is meant to be run block by block with real output pasted into
 * docs/verification-log.md, so the default here is to keep going after a failure and
 * report every result rather than stopping at the first one. `--stop-on-error` gives
 * the migration behaviour instead.
 *
 *   npx tsx scripts/sql.mts sql/001_init.sql --stop-on-error
 *   npx tsx scripts/sql.mts sql/000_verify.sql --only 1-6
 *   npx tsx scripts/sql.mts sql/000_verify.sql --dry-run
 *
 * .mts on purpose: the package is CommonJS but every source file is ESM, and this
 * extension sidesteps that argument entirely.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

export interface Statement {
  /** 1-based, as printed. */
  index: number;
  /** Line in the source file where the statement starts. */
  line: number;
  sql: string;
}

/**
 * Splits SQL on semicolons that are actually statement terminators.
 *
 * Semicolons inside string literals and comments are not terminators. The schema
 * relies on this: vector literals like '[1,0,0,0]' and cron expressions like
 * '*​/1 * * * *' sit inside quotes, and every file here is thick with `--` comments.
 */
/** True if the text carries anything besides blank space and `--` comments. */
function hasCode(text: string): boolean {
  return text
    .split('\n')
    .some((l) => l.replace(/--.*$/, '').trim() !== '');
}

export function splitStatements(source: string): Statement[] {
  const statements: Statement[] = [];
  let current = '';
  let line = 1;
  let startLine = 1;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  const push = () => {
    const sql = current.trim();
    current = '';
    const from = startLine;
    startLine = line;

    // A trailing run of comments (the commented-out GRANT block at the end of
    // 001_init.sql) is not a statement; sending it would be a pointless round trip.
    if (sql === '' || !hasCode(sql)) return;

    // Report the line the SQL starts on, not the line its comment header starts on,
    // so output can be matched back to the file when pasting into the log.
    const lead = sql.split('\n').findIndex((l) => hasCode(l));
    statements.push({ index: statements.length + 1, line: from + Math.max(lead, 0), sql });
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '\n') line += 1;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        current += '*/';
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        // '' is an escaped quote, not a terminator.
        if (next === "'") {
          current += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += '--';
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }

    if (ch === ';') {
      push();
      continue;
    }

    // Don't let leading blank lines/comments inflate the reported start line.
    if (current.trim() === '' && /\s/.test(ch)) {
      if (ch === '\n') startLine = line;
      continue;
    }

    current += ch;
  }

  push();
  return statements;
}

/** Strips comments so the printed heading shows the statement, not its preamble. */
function summarise(sql: string): string {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter((l) => l !== '')
    .join(' ');
  return bare.length > 100 ? `${bare.slice(0, 97)}...` : bare || '(comment only)';
}

function parseOnly(spec: string): (index: number) => boolean {
  const ranges = spec.split(',').map((part) => {
    const [from, to] = part.split('-');
    const lo = Number(from);
    const hi = to === undefined ? lo : Number(to);
    return { lo, hi };
  });
  return (index) => ranges.some(({ lo, hi }) => index >= lo && index <= hi);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const stopOnError = args.includes('--stop-on-error');
const onlyIdx = args.indexOf('--only');
const onlySpec =
  args.find((a) => a.startsWith('--only='))?.slice('--only='.length) ??
  (onlyIdx >= 0 ? args[onlyIdx + 1] : undefined);
const only = parseOnly(onlySpec === undefined || onlySpec === '' ? '1-99999' : onlySpec);

if (file === undefined) {
  console.error('usage: npx tsx scripts/sql.mts <file.sql> [--dry-run] [--stop-on-error] [--only 1-6]');
  process.exit(2);
}

const path = resolve(process.cwd(), file);
if (!existsSync(path)) {
  console.error(`no such file: ${path}`);
  process.exit(2);
}

const statements = splitStatements(readFileSync(path, 'utf8')).filter((s) => only(s.index));
console.log(`${file}: ${statements.length} statement(s)\n`);

if (dryRun) {
  for (const s of statements) {
    console.log(`[${s.index}] line ${s.line}: ${summarise(s.sql)}`);
  }
  process.exit(0);
}

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const dsn = process.env.CORTEX_DSN;
if (dsn === undefined || dsn.trim() === '') {
  console.error(
    'CORTEX_DSN is empty. Paste the CockroachDB Cloud connection string into .env.\n' +
      'If the password contains "#", single-quote the whole value: process.loadEnvFile\n' +
      'is not dotenv and will truncate at an unquoted "#".',
  );
  process.exit(1);
}

const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
let failures = 0;

try {
  await client.connect();
} catch (error) {
  const e = error as { code?: string; message?: string };
  console.error(`could not connect: code=${e.code ?? '(none)'} ${e.message}`);
  process.exit(1);
}

for (const s of statements) {
  console.log(`\n[${s.index}] line ${s.line}: ${summarise(s.sql)}`);
  try {
    const result = await client.query(s.sql);
    const rows = Array.isArray(result) ? result.flatMap((r) => r.rows) : result.rows;
    if (rows.length > 0) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      const command = Array.isArray(result) ? result.map((r) => r.command).join(', ') : result.command;
      console.log(`  ok (${command ?? 'no rows'})`);
    }
  } catch (error) {
    const e = error as { code?: string; message?: string; detail?: string; hint?: string };
    failures += 1;
    console.log(`  FAILED code=${e.code ?? '(none)'}`);
    console.log(`  ${e.message}`);
    if (e.detail) console.log(`  detail: ${e.detail}`);
    if (e.hint) console.log(`  hint: ${e.hint}`);
    if (stopOnError) {
      console.log('\nstopping (--stop-on-error)');
      break;
    }
  }
}

await client.end().catch(() => {});
console.log(`\n${statements.length - failures}/${statements.length} succeeded`);
process.exitCode = failures > 0 && stopOnError ? 1 : 0;
