/**
 * The named statements in `src/cli/statements.sql`, loaded once.
 *
 * Two things this buys beyond satisfying `scripts/gate-mechanical.sh`'s `sql-containment`
 * row: the CLI selects a statement by name and has no way to build one, and the statements
 * a judge would want to read — the privilege probes — are readable as SQL rather than as
 * string literals wrapped in control flow.
 *
 * An unknown name throws. A statement that is deleted from the file must not degrade into
 * a query that silently does nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { splitStatements } from './statements.js';

const SOURCE = fileURLToPath(new URL('./statements.sql', import.meta.url));

/** `-- name: x` above a statement makes it `x`. Statements without one are unreachable. */
export function parseNamedStatements(source: string): Map<string, string> {
  const named = new Map<string, string>();

  for (const statement of splitStatements(source)) {
    const name = /--\s*name:\s*([a-z_][a-z0-9_]*)/i.exec(statement.sql)?.[1];
    if (name === undefined) continue;

    const body = statement.sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    if (body !== '') named.set(name, body);
  }

  return named;
}

let cache: Map<string, string> | undefined;

export function statement(name: string): string {
  cache ??= parseNamedStatements(readFileSync(SOURCE, 'utf8'));
  const sql = cache.get(name);
  if (sql === undefined) {
    throw new Error(`no statement named "${name}" in src/cli/statements.sql`);
  }
  return sql;
}
