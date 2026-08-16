/**
 * Reading and appending `.env`, under one rule: APPEND ONLY.
 *
 * The file is open in an editor on this machine, it is the only place the cluster's
 * credentials exist, and it is not in git — so there is no undo for a rewrite. Nothing
 * here rewrites, reorders, reformats or overwrites. `appendMissingKeys` reads what is
 * there, decides which keys are absent, and appends those lines and nothing else. A key
 * that already exists is left exactly as it is, which is also what makes a second
 * `cortex init` a no-op.
 *
 * The parser follows `scripts/env-doctor.mts`'s reading of `process.loadEnvFile`: a
 * leading `export ` becomes part of the key name, a matched pair of quotes is stripped,
 * and an unquoted `#` truncates the value. Values are parsed because presence has to be
 * distinguished from emptiness. They are never printed by anything that imports this.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export interface EnvEntry {
  key: string;
  /** Never log this. Lengths and key names are the only things safe to print. */
  value: string;
  /** 1-based, as an editor counts. */
  line: number;
}

export function parseEnvFile(text: string): EnvEntry[] {
  const entries: EnvEntry[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const eq = trimmed.indexOf('=');
    if (eq === -1) return;

    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();

    const rawValue = trimmed.slice(eq + 1);
    const quoted = /^(['"]).*\1$/s.test(rawValue);
    const value = quoted ? rawValue.slice(1, -1) : rawValue.trim();

    entries.push({ key, value, line: index + 1 });
  });

  return entries;
}

export function readEnvFile(path: string): EnvEntry[] {
  if (!existsSync(path)) return [];
  return parseEnvFile(readFileSync(path, 'utf8'));
}

/**
 * Appends the keys that are absent and returns their names.
 *
 * Single-quoted, always: `process.loadEnvFile` is not dotenv and truncates an unquoted
 * value at a `#`. Generated passwords are base64url and carry no `#`, but an operator DSN
 * cloned from the Console can, and a quote costs nothing.
 */
export function appendMissingKeys(path: string, additions: Array<{ key: string; value: string }>): string[] {
  const present = new Set(readEnvFile(path).map((entry) => entry.key));
  const missing = additions.filter((addition) => !present.has(addition.key));
  if (missing.length === 0) return [];

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const leadingNewline = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const block = missing.map((addition) => `${addition.key}='${addition.value}'`).join('\n');

  appendFileSync(path, `${leadingNewline}\n# Added by \`cortex init\`.\n${block}\n`);
  return missing.map((addition) => addition.key);
}
