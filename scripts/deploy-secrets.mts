/**
 * Puts the deployment's secrets into AWS Secrets Manager, where `04` §2 requires them
 * to be, and prints nothing that would be worth stealing.
 *
 *   npx tsx scripts/deploy-secrets.mts
 *
 * Two secrets:
 *
 *   cortex/demo-dsn          the `cortex_demo` connection string, from .env
 *   cortex/changefeed-token  the `webhook_auth_header` the changefeed presents to the
 *                            sink, generated here on first run and reused after
 *
 * **Why this is a script and not a note in a README.** V22's finding was a credential
 * that reached `cdk.out/` because the arrangement that put it there looked correct. The
 * stack now takes both of these as `{{resolve:secretsmanager:...}}` dynamic references,
 * which means CloudFormation resolves them at deploy time and neither value is ever in
 * the template — but only if the secrets exist under exactly these names. A deploy
 * against a missing secret fails at CloudFormation with a message about a resolve
 * failure, and the tempting fix at that moment is to paste the value into the stack.
 *
 * The value is passed to the AWS CLI on **stdin**, never in argv: an argument is visible
 * in `ps` to every other process on the machine for as long as the call takes.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const DEMO_DSN_SECRET = 'cortex/demo-dsn';
const CHANGEFEED_TOKEN_SECRET = 'cortex/changefeed-token';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the AWS CLI, optionally feeding it a secret value on stdin. */
function aws(args: string[], stdin?: string): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawn('aws', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function currentValue(name: string): Promise<string | null> {
  const result = await aws([
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    name,
    '--query',
    'SecretString',
    '--output',
    'text',
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Creates the secret, or overwrites its value if it is already there. */
async function put(name: string, value: string): Promise<'created' | 'updated'> {
  // `file:///dev/stdin` is how the CLI reads a parameter from a pipe. The alternative,
  // `--secret-string "$VALUE"`, puts the credential in this process's argv.
  const create = await aws(
    ['secretsmanager', 'create-secret', '--name', name, '--secret-string', 'file:///dev/stdin'],
    value,
  );
  if (create.code === 0) return 'created';

  if (!/ResourceExistsException/.test(create.stderr)) {
    throw new Error(`could not create ${name}: ${create.stderr.trim()}`);
  }

  const update = await aws(
    [
      'secretsmanager',
      'put-secret-value',
      '--secret-id',
      name,
      '--secret-string',
      'file:///dev/stdin',
    ],
    value,
  );
  if (update.code !== 0) throw new Error(`could not update ${name}: ${update.stderr.trim()}`);

  return 'updated';
}

async function main(): Promise<void> {
  const demoDsn = process.env['CORTEX_DEMO_DSN'];
  if (!demoDsn) {
    throw new Error('CORTEX_DEMO_DSN is not set. The demo plane has no connection string.');
  }

  const demoOutcome = await put(DEMO_DSN_SECRET, demoDsn);
  console.log(`${DEMO_DSN_SECRET.padEnd(24)} ${demoOutcome}  (${demoDsn.length} chars, not printed)`);

  // Reused rather than rotated on every run: rotating it here would silently invalidate
  // the header on a changefeed job that is already running, and the job would keep
  // retrying against a sink that had started refusing it.
  const existing = await currentValue(CHANGEFEED_TOKEN_SECRET);
  if (existing) {
    console.log(`${CHANGEFEED_TOKEN_SECRET.padEnd(24)} kept     (${existing.length} chars, not printed)`);
    return;
  }

  const token = `Bearer ${randomBytes(32).toString('base64url')}`;
  const outcome = await put(CHANGEFEED_TOKEN_SECRET, token);
  console.log(`${CHANGEFEED_TOKEN_SECRET.padEnd(24)} ${outcome}  (${token.length} chars, not printed)`);
}

await main();
