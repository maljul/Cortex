/**
 * THE COMMIT BLOCK, MADE INDEPENDENT OF THE HARNESS.
 *
 * `.claude/settings.json` registers `scripts/gate-mechanical.sh` as a Claude Code
 * `PreToolUse` hook, and on 2026-08-13 it **did not fire** (V42) — four commits carrying a
 * credential-shaped string landed, each caught only afterwards by `--report`. The script was
 * not why: invoked directly with a commit payload it blocks correctly, exit 2. The
 * configuration on disk was correct too — executable, valid shebang, valid JSON, no
 * overriding `settings.local.json`. The harness simply did not run it.
 *
 * A hook that silently does not run looks exactly like a hook that passed. That is the same
 * shape as the always-red row this whole episode began with, so the fix is a route that does
 * not depend on the harness at all: git's own `pre-commit`, which runs for every commit made
 * through this repository however it is issued.
 *
 * **It preserves the split the gate already describes**, and that is the point of the
 * `CLAUDECODE` guard rather than an accident of implementation.
 * `scripts/gate-mechanical.sh`'s header: *"The hook governs commits made through Claude Code
 * only; a human committing from their own terminal is unaffected. That is the intended split:
 * the agent cannot decline, the human is not blocked."* `CLAUDECODE` is set in an agent's
 * shell and unset in Julian's, so the guard is exactly that sentence, executable.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const HOOK = fileURLToPath(new URL('../.githooks/pre-commit', import.meta.url));

/** Distinctive so cleanup can never remove anything else. */
const PROBE_FILE = 'GIT-HOOK-PROBE.tmp.txt';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

/**
 * Runs the hook as git would, with `CLAUDECODE` present or absent.
 *
 * `spawnSync` rather than `execFileSync` because a non-zero exit is the expected result of
 * half these calls and throwing on it would make the assertions read backwards.
 */
function runHook(asAgent: boolean): { status: number; output: string } {
  const env = { ...process.env };
  if (asAgent) env.CLAUDECODE = '1';
  else delete env.CLAUDECODE;

  const result = spawnSync('bash', [HOOK], { cwd: REPO, env, encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function unstageProbe(): void {
  spawnSync('git', ['restore', '--staged', PROBE_FILE], { cwd: REPO });
  rmSync(`${REPO}${PROBE_FILE}`, { force: true });
}

afterAll(unstageProbe);

describe('the pre-commit hook exists and is wired to run', () => {
  it('is a tracked, executable file', () => {
    expect(existsSync(HOOK), '.githooks/pre-commit is missing').toBe(true);
    // Tracked, so a clone gets it. `.git/hooks/` is not version controlled, which is why
    // `core.hooksPath` points somewhere that is.
    expect(git('ls-files', '.githooks/pre-commit')).toBe('.githooks/pre-commit');
    expect(() => execFileSync('test', ['-x', HOOK])).not.toThrow();
  });

  /**
   * `core.hooksPath` is local config and cannot be committed, so a fresh clone has to run one
   * command. That is asserted rather than skipped, deliberately and for the same reason
   * `test/privilege-planes.test.ts` refuses to skip an unset DSN: an unwired guard that
   * reports green is indistinguishable from a guard that works, which is the exact failure
   * this file exists to end. The message is the fix.
   */
  it('is the configured hooks path', () => {
    let configured = '';
    try {
      configured = git('config', 'core.hooksPath');
    } catch {
      configured = '';
    }

    expect(
      configured,
      'core.hooksPath is not set, so this repository\'s commit block is not installed. ' +
        'Run:  git config core.hooksPath .githooks',
    ).toBe('.githooks');
  });
});

describe('the human is not blocked and the agent cannot decline', () => {
  /**
   * The discriminating test, and it needs a genuinely failing gate to be worth anything —
   * with a clean index both branches exit 0 and prove nothing.
   *
   * So a credential-shaped line is staged for the duration. It is never committed: the file
   * is unstaged and deleted in `afterAll` as well as at the end of each test, and its name is
   * distinctive so cleanup cannot touch anything else. The string is assembled at run time
   * rather than written out, because a literal here would put an undeclared credential into
   * the history the gate scans — which is how this went wrong four times on 2026-08-13.
   */
  function stageProbe(): void {
    const line = `const dsn = 'postgresql://user:staged` + `@probe-host:26257/db';\n`;
    writeFileSync(`${REPO}${PROBE_FILE}`, line);
    execFileSync('git', ['add', PROBE_FILE], { cwd: REPO });
  }

  it('blocks an agent commit that stages a credential', () => {
    try {
      stageProbe();
      const { status, output } = runHook(true);

      expect(status, 'the hook let a staged credential through').not.toBe(0);
      expect(output).toMatch(/BLOCKED/);
      expect(output).toMatch(/credentials\s+FAIL/);
    } finally {
      unstageProbe();
    }
  });

  it('lets the same commit through when CLAUDECODE is unset', () => {
    try {
      stageProbe();
      const { status } = runHook(false);

      // Not an endorsement of the content — it is the documented split. A human committing
      // from their own terminal is unaffected, and `scripts/gate-mechanical.sh`'s header is
      // where that decision lives.
      expect(status, 'the hook blocked a human commit').toBe(0);
    } finally {
      unstageProbe();
    }
  });

  it('lets an agent commit through when nothing is wrong', () => {
    // The other half of the discrimination: the block above must be about the staged
    // credential, not about the hook refusing everything an agent does.
    const { status } = runHook(true);
    expect(status).toBe(0);
  });
});

describe('the guard is what makes this safe to install', () => {
  it('short-circuits on CLAUDECODE before it reaches the gate', () => {
    // Comments stripped first, and the first version of this test did not: both strings are
    // named in the header prose, so it compared the positions of two comments and failed on a
    // hook that was correct. `test/scenario.test.ts` strips comments before its source scan
    // for the same reason — a file that explains itself defeats a naive text search.
    const code = readFileSync(HOOK, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    const guard = code.indexOf('CLAUDECODE');
    const delegation = code.indexOf('gate-mechanical.sh');

    expect(guard, 'no CLAUDECODE guard — this would block Julian').toBeGreaterThan(-1);
    expect(delegation, 'the hook does not call the gate').toBeGreaterThan(-1);
    // Order matters: a guard after the delegation would still run the gate for a human, and
    // the whole argument for installing this is that it cannot.
    expect(guard).toBeLessThan(delegation);
  });
});
