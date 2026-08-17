/**
 * `node bin/cortex.mjs <command>` — the typed dispatcher behind `bin/cortex.mjs`.
 *
 * It is **not** `npx cortex`. This package is not published to npm, and the name `cortex`
 * on the public registry belongs to an unrelated package, so `npx cortex` either fetches
 * that one or fails naming it. Every invocation printed by this file runs the bin
 * directly, and `test/cli-init.test.ts` fails if `npx cortex` reappears in the help.
 *
 * `05` §2 lists nine commands. **Two exist: `init` and `doctor`.** Anything else exits 1
 * naming what to run instead, because a bin that silently does nothing for `cortex bench`
 * is worse than no bin — the command is in the spec's own table, so a reader will try it.
 * The redirect is derived from `package.json`'s scripts rather than listed here, so a
 * command that becomes an npm script starts being named the day it is added.
 *
 * Exit codes are `05` §2's: 0 success, 1 error. (10 blocked and 11 deduped belong to the
 * claim commands, which do not exist here; nothing returns them.)
 *
 * `--json` is required of every command by `05` §2. In that mode the report is the ONLY
 * thing on stdout — progress goes nowhere — so the output is machine-consumable without a
 * caller having to strip a banner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { doctor } from './doctor.js';
import { init } from './init.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function packageJson(): { version: string; scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string;
    scripts?: Record<string, string>;
  };
}

const HELP = `cortex — CORTEX's command line (spec/05-INTERFACES.md §2)

usage: node bin/cortex.mjs <command> [--json]

Run the bin directly, not as "npx cortex" — that name belongs to an unrelated
package on the public npm registry.

  node bin/cortex.mjs init      Bring a cluster from empty to working: create
                                the SQL roles sql/001_init.sql grants to, write
                                their connection strings into .env, apply the
                                schema, and prove the privilege planes by
                                attempting statements against them. Safe to run
                                twice — an existing role is left alone and no
                                password is ever rotated.
  node bin/cortex.mjs doctor    Cluster health: what .env carries, which planes
                                connect and as whom, which tables the cluster
                                has, and whether a connection string appears in
                                any tracked file. Exits 1 if one does.
  node bin/cortex.mjs --help
  node bin/cortex.mjs --version

init does NOT provision a cluster. Get an operator connection string either from
the Console at cockroachlabs.cloud, or with "ccloud auth login" then
"ccloud quickstart" if you have the ccloud CLI. Put it in .env as CORTEX_DSN,
then run init. Running init without CORTEX_DSN prints both routes and tells you
which one this machine can take.

No command prints a credential. Key names, character counts and verdicts only.

Everything else in this repository runs through npm scripts — npm run serve,
npm run bench, npm test, and the gates listed in CLAUDE.md.`;

/** Returns a process exit code. Never calls process.exit, so it is testable in-process. */
export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const flags = argv.filter((argument) => argument.startsWith('-'));
  const command = argv.find((argument) => !argument.startsWith('-'));

  if (flags.includes('--version') || flags.includes('-v')) {
    process.stdout.write(`${packageJson().version}\n`);
    return 0;
  }

  if (command === undefined || command === 'help' || flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const envPath = resolve(REPO_ROOT, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const log = (line: string): void => {
    if (!json) process.stdout.write(`${line}\n`);
  };

  if (command === 'init') {
    log('cortex init\n');
    const report = await init({ repoRoot: REPO_ROOT, log });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      log(
        `\ncreated ${report.rolesCreated} role(s), appended ${report.envKeysAppended} .env key(s)` +
          `${report.rolesCreated === 0 && report.envKeysAppended === 0 ? ' — nothing changed' : ''}`,
      );
    }
    for (const problem of report.problems) process.stderr.write(`\nERROR: ${problem}\n`);
    if (!json && report.ok) log('\nOK');
    return report.ok ? 0 : 1;
  }

  if (command === 'doctor') {
    log('cortex doctor\n');
    const report = await doctor({ repoRoot: REPO_ROOT, log });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const problem of report.problems) process.stderr.write(`\nERROR: ${problem}\n`);
    if (!json && report.ok) log('\nOK');
    return report.ok ? 0 : 1;
  }

  const scripts = packageJson().scripts ?? {};
  const script = Object.keys(scripts).find((name) => name === command || name.endsWith(`:${command}`));

  process.stderr.write(
    script === undefined
      ? `cortex ${command} does not exist.\n\n` +
          'This bin implements two commands: `node bin/cortex.mjs init` and\n' +
          '`node bin/cortex.mjs doctor`.\n' +
          `Run \`node bin/cortex.mjs --help\` for what they do, or \`npm run\` for this\n` +
          "repository's scripts.\n"
      : `cortex ${command} is not implemented as a bin command.\n\n` +
          `Run \`npm run ${script}\` instead.\n\n` +
          'This bin implements two commands: `node bin/cortex.mjs init` and\n' +
          '`node bin/cortex.mjs doctor`.\n',
  );
  return 1;
}
