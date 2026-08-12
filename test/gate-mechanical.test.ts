/**
 * THE GATE'S OWN GATE — a row that is always red is a row nobody reads.
 *
 * `scripts/gate-mechanical.sh` says that about itself, in the comment above its placeholder
 * list, and then it happened anyway: from 2026-08-11 the `credentials` row of
 * `--report` failed on every run, on three of this repository's own placeholder strings.
 * Nothing noticed, because nothing ran the script except `/check` and a human reading a
 * FAIL they had learned to expect.
 *
 * So the script is now under test. Two properties, and the second is the one that matters:
 *
 * 1. `--report` passes. A red row trains its reader to ignore the row.
 * 2. The placeholder blessing is **by exact string, not by shape**. This is the property
 *    that keeps fixing (1) from being a weakening. A shape — the old `user:password@` —
 *    excuses an unbounded family of strings nobody has ever seen, forever, in any file. An
 *    inventory of literals excuses exactly what a human wrote down, and any new
 *    credential-shaped string fails until someone declares it deliberately.
 *
 * Neither test may be relaxed to make the row green. If the check is wrong, that is a
 * conversation, not an edit — the script says so itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = readFileSync(new URL('../scripts/gate-mechanical.sh', import.meta.url), 'utf8');

/**
 * The declared placeholders, read out of the script rather than restated here.
 *
 * Restating them would be a second literal that can drift, which is the mistake V14 caught
 * in the Agent Skill and V34 caught in the recall threshold. The markers exist so this
 * parse cannot silently start matching nothing: an empty result fails the first assertion
 * below, and an empty inventory is the script's own worst failure mode — `grep -vF ""`
 * excuses every line there is.
 */
function declaredPlaceholders(): string[] {
  const block = /# BEGIN PLACEHOLDER INVENTORY\n[\s\S]*?<<'PLACEHOLDERS'\n([\s\S]*?)\nPLACEHOLDERS\n/.exec(
    SCRIPT,
  );
  return (block?.[1] ?? '').split('\n').filter((line) => line.trim() !== '');
}

describe('the mechanical gate passes its own rows', () => {
  /**
   * Given a longer budget than the suite default on purpose: this runs `npx tsc --noEmit`
   * and `git log -p --all` for real, because a test that stubbed either would be asserting
   * something other than what `/check` row 4 runs.
   */
  it(
    'reports PASS on every row',
    () => {
      const output = execFileSync('bash', ['scripts/gate-mechanical.sh', '--report'], {
        cwd: REPO,
        encoding: 'utf8',
      });

      for (const row of ['typecheck', 'sql-containment', 'env-ignored', 'credentials']) {
        expect(output, `${row} is not PASS`).toMatch(new RegExp(`^${row}\\s+PASS`, 'm'));
      }
      expect(output).toContain('mechanical rows: PASS');
    },
    120_000,
  );
});

describe('the placeholder blessing is by literal, never by shape', () => {
  it('declares at least one placeholder, so the exclusion cannot match everything', () => {
    // `grep -vF ""` excuses every line in the scan. An inventory that parsed to nothing
    // would turn the credentials row into an unconditional PASS, which is worse than the
    // FAIL it replaced.
    expect(declaredPlaceholders().length).toBeGreaterThan(0);
  });

  it('declares whole connection strings, not fragments a family could hide behind', () => {
    for (const entry of declaredPlaceholders()) {
      expect(entry, `${entry} is a fragment, not a connection string`).toMatch(
        /^postgresql:\/\/[^@\s]+@[^\s]+$/,
      );
    }
  });

  /**
   * THE ASSERTION THAT KEEPS THIS FROM BEING A WEAKENING.
   *
   * A line the same *shape* as a declared placeholder, differing only in host and database,
   * must not be excused. Under the old `user:password@` pattern it was — that pattern
   * excused every connection string whose password happened to be the word `password`,
   * whatever host it named. Under an inventory it is caught, and the only way to excuse it
   * is to write it down.
   *
   * The match is modelled on `grep -vF`: a line is excused when it *contains* a declared
   * entry, so the check is whether any entry is a substring of the probe line.
   */
  it('does not excuse a new string that merely looks like a declared one', () => {
    // Assembled rather than written out, and the join is at the `@` on purpose. Spelled as
    // one literal this line would itself be an undeclared credential-shaped string in the
    // history the check scans — which is not hypothetical: the first version of this file
    // was committed that way and turned the row red on the very next run. The check was
    // right, and that is the strongest evidence for the property below that exists.
    // Neither half matches on its own: the first carries no `@`, the second no scheme.
    const probe = `+  const dsn = 'postgresql://user:password` + `@probe.invalid:26257/db';`;

    for (const entry of declaredPlaceholders()) {
      expect(probe.includes(entry), `${entry} would excuse an undeclared credential`).toBe(
        false,
      );
    }
  });
});
