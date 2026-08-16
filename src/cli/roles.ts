/**
 * What `cortex init` has to create, read out of the migration rather than listed here.
 *
 * `03` §2's roles are named in exactly one place — `sql/001_init.sql`'s GRANT and CREATE
 * POLICY statements — and a second list here would be a second source of truth that goes
 * stale silently: a fourth service account added to the migration would be granted to and
 * never created, and the failure would surface as a GRANT erroring on a fresh cluster long
 * after the change was made. So the list is derived. `test/cli-init.test.ts` mutates a copy
 * of the migration and requires the derived list to follow it.
 */
import { splitStatements } from './statements.js';

/** Names that appear where a role does but are not accounts anyone can log in as. */
const NOT_A_LOGIN = new Set(['public', 'current_user', 'session_user', 'all']);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Strips comments and collapses whitespace so a statement can be matched as one line. */
function bare(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collect(list: string, into: Set<string>): void {
  for (const part of list.split(',')) {
    const name = part.trim().replace(/^"(.*)"$/, '$1');
    if (name === '' || NOT_A_LOGIN.has(name.toLowerCase()) || !IDENTIFIER.test(name)) continue;
    into.add(name);
  }
}

/**
 * Every SQL role the migration expects to exist, sorted.
 *
 * Two shapes carry one: `GRANT ... TO <roles>` and `CREATE POLICY ... TO <role> USING`.
 * Both are read, because a role could in principle be named only by a policy — RLS denies
 * everything to a role with no policy, so a policy is as load-bearing as a grant.
 */
export function deriveRoles(sql: string): string[] {
  const roles = new Set<string>();

  for (const statement of splitStatements(sql)) {
    const text = bare(statement.sql);

    if (/^GRANT\b/i.test(text)) {
      // The LAST `TO`, because a grant over a list of tables has exactly one and a grant
      // over a function must not be confused by the argument list in its signature.
      //
      // (Spelled out in prose rather than shown as an example, because
      // `scripts/gate-mechanical.sh`'s sql-containment row is a grep over `src/**/*.ts`
      // and does not know a comment from a query. Every statement this CLI sends is in
      // `src/cli/statements.sql`.)
      const to = text.toUpperCase().lastIndexOf(' TO ');
      if (to === -1) continue;
      collect(text.slice(to + 4).replace(/\bWITH\b[\s\S]*$/i, ''), roles);
      continue;
    }

    if (/^CREATE\s+POLICY\b/i.test(text)) {
      const match = /\bTO\s+(.+?)\s+(?:USING|WITH\s+CHECK)\b/i.exec(text);
      if (match?.[1] !== undefined) collect(match[1], roles);
    }
  }

  return [...roles].sort();
}

/**
 * Every table the migration creates, sorted. `cortex doctor` reports which of them the
 * cluster actually has, and deriving it here means a seventh table (`live_run_budget` was
 * one, in U17) is covered the day it is added.
 */
export function deriveTables(sql: string): string[] {
  const tables = new Set<string>();

  for (const statement of splitStatements(sql)) {
    const match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(bare(statement.sql));
    if (match?.[1] !== undefined) tables.add(match[1]);
  }

  return [...tables].sort();
}
