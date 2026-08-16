/**
 * Puts the deployment's secrets into AWS Secrets Manager, where `04` §2 requires them
 * to be, and prints nothing that would be worth stealing.
 *
 *   npx tsx scripts/deploy-secrets.mts
 *
 * Three secrets:
 *
 *   cortex/demo-dsn          the `cortex_demo` connection string, from .env
 *   cortex/live-token        the capability token that enables a LIVE (model-authored) run,
 *                            compared server-side and never echoed into the DOM
 *   cortex/changefeed-token  the `webhook_auth_header` the changefeed presents to the
 *                            sink, generated here on first run and reused after
 *
 * **Why this is a script and not a note in a README.** V22's finding was a credential
 * that reached `cdk.out/` because the arrangement that put it there looked correct. The
 * stack now takes each of these as a `{{resolve:secretsmanager:...}}` dynamic reference,
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
const LIVE_TOKEN_SECRET = 'cortex/live-token';

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
  // retrying against a sink that had started refusing it. The same argument applies to the
  // LIVE token for a different reason, so both go through one helper rather than two blocks
  // that could drift on the half that matters.
  await keepOrCreate(CHANGEFEED_TOKEN_SECRET, () => `Bearer ${randomBytes(32).toString('base64url')}`);

  /**
   * The LIVE capability token, `04` §5 brake 2 and design §7.1.
   *
   * **No `Bearer ` prefix, and that is not cosmetic.** The changefeed's token is an HTTP header;
   * this one travels in a URL as `/?live=<token>`, so it must survive being a query parameter.
   * `base64url` is the alphabet that does — a space and a `+` do not.
   *
   * **Never rotated once it exists**, and the reason is sharper than the changefeed's: this value
   * goes in the link pasted into the Devpost submission. Rotating it would silently turn a judge's
   * LIVE link into a REPLAY one, with no error anywhere — which is precisely the class of failure
   * `04` §5 invariant 1 forbids, arriving by way of a deploy script.
   *
   * It is never printed. Julian retrieves it once, deliberately, with an explicit
   * `aws secretsmanager get-secret-value`, when he builds the link.
   */
  await keepOrCreate(LIVE_TOKEN_SECRET, () => randomBytes(32).toString('base64url'));
}

/** Create a secret if it is absent; keep — and never print — whatever is already there. */
async function keepOrCreate(name: string, make: () => string): Promise<void> {
  const existing = await currentValue(name);
  if (existing) {
    console.log(`${name.padEnd(24)} kept     (${existing.length} chars, not printed)`);
    return;
  }

  const value = make();
  const outcome = await put(name, value);
  console.log(`${name.padEnd(24)} ${outcome}  (${value.length} chars, not printed)`);
}

await main();
