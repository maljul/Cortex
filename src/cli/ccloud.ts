/**
 * The ccloud CLI's entire role in this project: onboarding help, and nothing else.
 *
 * **Read this before extending it.** `cortex init` is provisioning-optional and stays that
 * way — `05` §2's table says "provision a free cluster with ccloud" and this project does
 * not, which is a live deviation recorded in `docs/SPEC-DELTA.md`. Nothing here creates a
 * cluster, creates a SQL user, or reads a connection string out of ccloud. It answers one
 * question — is ccloud on this machine, and which version — and turns that answer into the
 * instructions `cortex init` prints when it has no `CORTEX_DSN` to work with.
 *
 * That boundary is deliberate rather than unfinished. A `cortex init` that provisions is a
 * command that can spend money and create infrastructure on a path a user reaches by typing
 * four words, and the honest version of it needs an authenticated ccloud, a cluster-tier
 * decision and a confirmation step. What it would buy — one fewer copy-paste — is not worth
 * building unverified. Anything beyond detection is a new unit with its own done-when.
 *
 * **The version banner is surfaced verbatim and not parsed.** `ccloud version` on 0.8.23
 * prints two lines (`ccloud 0.8.23`, then a `CCAPI` date); an earlier draft of the test
 * guessed a single `ccloud version X.Y.Z` line and guessed wrong. Parsing a format nothing
 * has shown us is the same class of mistake as trusting a catalogue listing — so this reads
 * the first non-empty line and prints it as-is. If ccloud changes its banner, the row in
 * `cortex doctor` changes with it and nothing breaks.
 *
 * **On `execFileSync` with an argv array.** Never a shell string. A binary path or a
 * version string interpolated into a shell is a command-injection surface, and invariant 7
 * is this project's rule against exactly that shape everywhere else. `test/cli-ccloud.test.ts`
 * asserts the argv rather than trusting this paragraph.
 */
import { execFileSync } from 'node:child_process';

export interface CcloudReport {
  installed: boolean;
  /** The first line of `ccloud version`, verbatim. Null when ccloud did not answer. */
  version: string | null;
}

export interface DetectOptions {
  /**
   * The executable to probe. Defaults to `ccloud`, resolved on `PATH` the way a user's own
   * shell would resolve it — "is ccloud installed" is a question about their PATH, not about
   * a location we could hardcode. Overridden by the tests to point at a fixture.
   */
  binary?: string;
}

/**
 * Whether ccloud is available, by running it.
 *
 * Never throws. Every caller is already on a degraded path — `cortex init` has no DSN, or
 * `cortex doctor` is reporting — and a diagnostic that replaces the user's instructions with
 * a stack trace about the diagnostic is worse than one that reports "absent". A missing
 * binary, a non-zero exit and a hang all mean the same thing to a caller: no ccloud to
 * suggest commands for.
 */
export function detectCcloud(options: DetectOptions = {}): CcloudReport {
  const binary = options.binary ?? 'ccloud';

  try {
    const output = execFileSync(binary, ['version'], {
      encoding: 'utf8',
      // A bounded wait. `cortex init`'s job is to report why it cannot proceed, and it
      // cannot do that while blocked on a binary that never returns.
      timeout: 5_000,
      // stderr is discarded rather than inherited: ccloud writes progress and update
      // notices there, and this is a probe whose only output should be the caller's.
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const firstLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '');

    return { installed: true, version: firstLine ?? null };
  } catch {
    return { installed: false, version: null };
  }
}

/**
 * What to print when `CORTEX_DSN` is missing.
 *
 * Both routes are always named, in this order, and that ordering is the point: the Console
 * is first because it needs nothing installed and works for everyone, and ccloud is second
 * because it is faster for someone who already lives in a terminal. Naming only ccloud
 * would make an optional tool look required, which is the misreading `05` §2's deviation
 * exists to prevent.
 *
 * The install line is omitted when ccloud is already present. Instructions that tell you to
 * install what you have are how instructions stop being read.
 *
 * **No example connection string appears here, in any form.** `cortex doctor` scans every
 * tracked file for a credential shape and this module is a tracked file; an illustrative
 * DSN would turn that check red, and the check is right — a realistic-looking credential in
 * help text is how a real one eventually gets pasted next to it.
 */
export function operatorDsnGuidance(ccloud: CcloudReport): string {
  const lines = [
    'CORTEX_DSN is not set, and `cortex init` does not provision a cluster.',
    '',
    'Two ways to get an operator connection string:',
    '',
    '  A. CockroachDB Cloud Console — https://cockroachlabs.cloud',
    '     Your cluster → Connect → General connection string.',
    '',
    '  B. ccloud CLI:',
  ];

  if (ccloud.installed) {
    lines.push(`       (detected: ${ccloud.version ?? 'version unknown'})`);
  } else {
    lines.push('       brew install cockroachdb/tap/ccloud');
  }

  lines.push(
    '       ccloud auth login',
    '       ccloud quickstart        # choose "General connection string"',
    '',
    "Put it in .env as CORTEX_DSN, single-quoted — Node's env-file loader truncates",
    "at an unquoted '#', which is a legal password character. Then run init again.",
  );

  return lines.join('\n');
}
