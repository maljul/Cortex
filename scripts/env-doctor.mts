/**
 * Diagnoses why a key in .env is not arriving in process.env.
 *
 *   npm run env:doctor
 *
 * Prints key names, value lengths and structural problems. Never prints a value.
 *
 * The subtle one this exists to catch: Node's env-file loader does NOT override a
 * variable that is already present in the environment. If CORTEX_DSN is exported as
 * an empty string by a shell profile, .env is read and then ignored, and every error
 * message says "empty" no matter what you paste into the file.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
const KEY = process.argv[2] ?? 'CORTEX_DSN';

// Snapshot the shell environment BEFORE the file is loaded.
const fromShell = process.env[KEY];

let raw: string;
let stats;
try {
  stats = statSync(ENV_PATH);
  raw = readFileSync(ENV_PATH, 'utf8');
} catch (error) {
  console.error(`cannot read ${ENV_PATH}: ${(error as Error).message}`);
  process.exit(1);
}

console.log(`file      ${ENV_PATH}`);
console.log(`modified  ${stats.mtime.toISOString()}`);
console.log(`size      ${stats.size} bytes`);

const problems: string[] = [];
if (raw.charCodeAt(0) === 0xfeff) problems.push('starts with a UTF-8 BOM, which corrupts the first key name');
if (raw.includes('\r')) problems.push('has CRLF line endings; the \\r becomes part of every value');

console.log('\nkeys');
const seen = new Map<string, number[]>();
const lines = raw.split(/\r?\n/);

lines.forEach((line, i) => {
  const n = i + 1;
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return;

  const eq = trimmed.indexOf('=');
  if (eq === -1) {
    problems.push(`line ${n}: no "=" — not a key/value line`);
    return;
  }

  let key = trimmed.slice(0, eq);
  const value = trimmed.slice(eq + 1);

  if (key.startsWith('export ')) {
    problems.push(`line ${n}: "export " prefix — Node's loader treats it as part of the key name`);
    key = key.slice('export '.length).trim();
  }
  if (key !== key.trim()) problems.push(`line ${n}: space before "=" becomes part of the key name`);
  key = key.trim();

  const quoted = /^(['"]).*\1$/s.test(value);
  const bare = quoted ? value.slice(1, -1) : value;

  seen.set(key, [...(seen.get(key) ?? []), n]);

  const state = bare.trim() === '' ? 'EMPTY' : `${bare.length} chars${quoted ? ', quoted' : ''}`;
  console.log(`  line ${String(n).padStart(3)}  ${key.padEnd(24)} ${state}`);

  if (bare.trim() !== '') {
    if (value.startsWith(' ')) problems.push(`line ${n}: space after "=" becomes part of the value`);
    if (!quoted && bare.includes('#')) {
      problems.push(`line ${n}: unquoted "#" — everything after it is dropped as a comment`);
    }
    if (!quoted && /\s/.test(bare)) problems.push(`line ${n}: unquoted whitespace in the value`);
    if (bare !== bare.trim()) problems.push(`line ${n}: trailing whitespace in the value`);
  }
});

for (const [key, at] of seen) {
  if (at.length > 1) {
    problems.push(`${key} is defined ${at.length}x (lines ${at.join(', ')}) — the last one wins`);
  }
}

console.log(`\n=== ${KEY} ===`);
const inFile = seen.has(KEY);
const fileLines = seen.get(KEY) ?? [];
console.log(`in file    ${inFile ? `yes (line ${fileLines.join(', ')})` : 'NO'}`);
console.log(
  `in shell   ${
    fromShell === undefined ? 'no' : fromShell === '' ? 'YES, as an EMPTY STRING' : `yes (${fromShell.length} chars)`
  }`,
);

if (fromShell !== undefined) {
  console.log(
    `\n*** ${KEY} is already set in your shell environment. ***\n` +
      "Node's env-file loader does not override variables that already exist, so the\n" +
      '.env file is being read and then ignored. Find and remove it:\n\n' +
      `  grep -rn '${KEY}' ~/.zshrc ~/.zshenv ~/.zprofile ~/.profile\n\n` +
      `then open a NEW terminal (unset ${KEY} only fixes the current one).`,
  );
}

if (problems.length > 0) {
  console.log('\nproblems');
  for (const p of problems) console.log(`  - ${p}`);
} else if (fromShell === undefined) {
  console.log('\nno structural problems found');
}
