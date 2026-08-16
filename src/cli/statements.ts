/**
 * The SQL statement splitter, copied byte-for-byte from `scripts/sql.mts`.
 *
 * **It is a copy because that module cannot be imported.** Everything from
 * `const args = process.argv.slice(2)` down runs at module scope: importing it for its
 * exported `splitStatements` parses `process.argv`, prints a usage line and calls
 * `process.exit(2)`. That is measured, not assumed — an import probe exits 2 before the
 * namespace is ever returned.
 *
 * `test/cli-init.test.ts` pins the two functions below against the ones in
 * `scripts/sql.mts` and fails if either drifts, which is the same device
 * `test/skill.test.ts` uses for `RECALL_SQL`: two places must carry one thing, they
 * cannot share it, so equality is asserted instead of assumed. `cortex init` and
 * `npm run sql` sending a migration to the cluster differently is exactly the class of
 * difference nobody would look for.
 *
 * The permanent fix is an entrypoint guard around that file's CLI section, after which
 * this module should be deleted in favour of importing it. Do not "improve" the copy.
 */

export interface Statement {
  /** 1-based, as printed. */
  index: number;
  /** Line in the source file where the statement starts. */
  line: number;
  sql: string;
}

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
