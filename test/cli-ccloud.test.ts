/**
 * `src/cli/ccloud.ts` — the ccloud CLI's only role in this project, and its limits.
 *
 * **What this module does NOT do, so no test here implies otherwise.** It does not
 * provision a cluster, it does not create a SQL user, and it does not read a connection
 * string out of ccloud. `cortex init` is still provisioning-optional and still takes an
 * operator DSN the user supplies; `src/cli/init.ts`'s header comment and `05` §2's
 * deviation in `docs/SPEC-DELTA.md` stay true after this file. All this module does is
 * answer "is ccloud here, and which version", and turn that answer into the onboarding
 * instructions `cortex init` prints when it has no DSN to work with.
 *
 * **On the fake binary.** This repository's rule is that a mock, an in-memory DB or a
 * local stand-in does not count as verification — and that rule is about the *cluster*,
 * whose behaviour is the thing under test everywhere else. Here the subject is argv
 * construction and the parsing of another process's stdout, and a fixture executable
 * tests exactly that: it proves we spawn `ccloud version` as an argv array rather than a
 * shell string, and that we surface what comes back rather than inventing it. What a
 * fixture cannot prove is what the *real* ccloud prints, so `detectCcloud` is written to
 * surface the first line verbatim rather than to parse a format it has been told about.
 * The real binary's output is recorded in `docs/verification-log.md` from an actual run.
 *
 * **Why argv rather than a shell string is a test and not a comment.** A binary path or a
 * version string interpolated into a shell is a command-injection surface, and invariant 7
 * — no agent-reachable path accepts a structural parameter — is the rule this project
 * enforces everywhere else. `execFileSync` with an argv array cannot be talked into
 * running a second command; a template string can. The fixture records its own `$@` so
 * that property is asserted rather than asserted-in-a-comment.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectCcloud, operatorDsnGuidance } from '../src/cli/ccloud.js';
import { init } from '../src/cli/init.js';

/** A URL carrying a userinfo section — `src/cli/doctor.ts`'s shape, reused deliberately. */
const CONNECTION_STRING = /[a-z][a-z0-9+.-]*:\/\/[^\s'"/@]+:[^\s'"/@]+@/i;

const REPO = fileURLToPath(new URL('..', import.meta.url));

let workspace: string;
/** Where the fixture writes the argv it was handed, so the call shape can be asserted. */
let argvLog: string;

/** A stand-in `ccloud` that records how it was invoked and prints a version banner. */
function writeFakeCcloud(name: string, body: string): string {
  const path = join(workspace, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cortex-ccloud-'));
  argvLog = join(workspace, 'argv.txt');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('detectCcloud', () => {
  it('reports absent when the binary is not on PATH', () => {
    // The name is deliberately one nothing can provide, so this is ENOENT rather than a
    // machine that happens not to have ccloud — the test must fail for one reason only.
    const report = detectCcloud({ binary: 'cortex-no-such-binary-c8f21e' });

    expect(report.installed).toBe(false);
    expect(report.version).toBeNull();
  });

  it('reports installed and surfaces the version line verbatim', () => {
    const binary = writeFakeCcloud(
      'ccloud-ok',
      '#!/bin/sh\necho "ccloud version 25.3.0 (darwin-arm64)"\n',
    );

    const report = detectCcloud({ binary });

    expect(report.installed).toBe(true);
    // Verbatim, not reformatted: we have not verified the real banner's shape, so parsing
    // it into fields would be asserting something no run has shown.
    expect(report.version).toBe('ccloud version 25.3.0 (darwin-arm64)');
  });

  it('invokes the binary with an argv array, never a shell string', () => {
    const binary = writeFakeCcloud(
      'ccloud-argv',
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\necho "ccloud version 1.0.0"\n`,
    );

    detectCcloud({ binary });

    // One argument, exactly `version`. A shell string would have arrived as one blob, and
    // a binary path containing a space or a semicolon would have split into several.
    expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual(['version']);
  });

  it('reports absent rather than throwing when the binary fails', () => {
    const binary = writeFakeCcloud('ccloud-broken', '#!/bin/sh\nexit 3\n');

    // `cortex init` calls this on a path where it already has no DSN. A throw here would
    // replace the guidance the user needs with a stack trace about a diagnostic.
    const report = detectCcloud({ binary });

    expect(report.installed).toBe(false);
    expect(report.version).toBeNull();
  });
});

describe('operatorDsnGuidance', () => {
  it('names the install commands when ccloud is absent', () => {
    const text = operatorDsnGuidance({ installed: false, version: null });

    expect(text).toContain('brew install cockroachdb/tap/ccloud');
    expect(text).toContain('ccloud auth login');
    expect(text).toContain('ccloud quickstart');
  });

  it('skips the install step when ccloud is already present', () => {
    const text = operatorDsnGuidance({ installed: true, version: 'ccloud version 25.3.0' });

    // Telling someone to install what they already have is how instructions stop being read.
    expect(text).not.toContain('brew install');
    expect(text).toContain('ccloud auth login');
    expect(text).toContain('ccloud quickstart');
  });

  it('still names the Console route, because ccloud is not required', () => {
    // `init` must remain usable by someone who will never install ccloud — that is the
    // whole of `05` §2's provisioning-optional deviation.
    const absent = operatorDsnGuidance({ installed: false, version: null });
    const present = operatorDsnGuidance({ installed: true, version: 'ccloud version 25.3.0' });

    expect(absent).toContain('cockroachlabs.cloud');
    expect(present).toContain('cockroachlabs.cloud');
  });

  it('names CORTEX_DSN and the single-quoting rule', () => {
    // `process.loadEnvFile` truncates at an unquoted '#', which is a real password character
    // and has cost a confusing failure before. The guidance is the place that warning lands.
    const text = operatorDsnGuidance({ installed: false, version: null });

    expect(text).toContain('CORTEX_DSN');
    expect(text).toContain('single-quote');
  });

  it('is what `cortex init` reports when it has no DSN', async () => {
    // The seam this whole module exists for. `init` used to push a single static sentence
    // here; the test asserts the guidance actually reaches the user rather than existing
    // beside the code path that needed it.
    const saved = process.env.CORTEX_DSN;
    delete process.env.CORTEX_DSN;
    try {
      const report = await init({ repoRoot: REPO, log: () => {} });

      expect(report.ok).toBe(false);
      // No cluster was contacted — a missing DSN returns before anything connects, which
      // is why this test costs nothing and is not in the live block.
      expect(report.problems.join('\n')).toContain('ccloud quickstart');
      expect(report.problems.join('\n')).toContain('cockroachlabs.cloud');
    } finally {
      if (saved !== undefined) process.env.CORTEX_DSN = saved;
    }
  });

  it('contains no credential-shaped string', () => {
    // Guidance that carried an example DSN would turn `cortex doctor`'s own tracked-file
    // scan red, and would be the leak that check exists to prevent.
    for (const installed of [true, false]) {
      const text = operatorDsnGuidance({ installed, version: installed ? 'ccloud version 1' : null });
      expect(CONNECTION_STRING.test(text)).toBe(false);
    }
  });
});
