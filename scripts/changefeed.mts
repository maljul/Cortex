/**
 * Creates, lists and cancels the changefeed that drives `04` §2's live memory stream.
 *
 *   npx tsx scripts/changefeed.mts status
 *   npx tsx scripts/changefeed.mts create
 *   npx tsx scripts/changefeed.mts cancel <job_id>
 *
 * `create` is idempotent in the way that matters: it cancels any feed this script
 * previously created against the same sink before creating a new one. Two feeds on the
 * same tables posting to the same sink would double every event on the demo panel, and
 * the duplicate would look like the mechanism emitting twice rather than like two jobs.
 *
 * **The webhook auth header comes from Secrets Manager, not from here and not from
 * `.env`.** It is the same secret the sink Lambda reads, so the two cannot drift; and it
 * never appears in this file, in argv, or in any output below. What is printed is the job
 * id and its status, which is what you need to know whether delivery is working.
 *
 * The sink URI is a CloudFormation output for the same reason `deploy-site.mts` reads
 * one: the API's hostname is not knowable until the stack exists.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const STACK = 'CortexStack';

/**
 * The tables the live view needs. `04` §2's flow E is about the demo panel updating from
 * the database's own change stream, and the three tiers a visitor watches move are these.
 * `findings` is included because beat 4 is consolidation arriving, and `action_ledger`
 * and `repos` are not, because nothing on screen renders them.
 */
const WATCHED = ['intents', 'claims', 'findings'];

function aws(args: string[]): string {
  const result = spawnSync('aws', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`aws failed: ${result.stderr}`);
  return result.stdout.trim();
}

function sinkUrl(): string {
  const url = aws([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    STACK,
    '--query',
    "Stacks[0].Outputs[?OutputKey=='ChangefeedSink'].OutputValue",
    '--output',
    'text',
  ]);
  if (!url) throw new Error(`${STACK} has no ChangefeedSink output. Deploy it first.`);
  return url;
}

function authHeader(): string {
  return aws([
    'secretsmanager',
    'get-secret-value',
    '--secret-id',
    'cortex/changefeed-token',
    '--query',
    'SecretString',
    '--output',
    'text',
  ]);
}

interface Job {
  job_id: string;
  status: string;
  error: string;
  description: string;
}

async function jobs(client: Client): Promise<Job[]> {
  const { rows } = await client.query<Job>(
    `SELECT job_id::STRING AS job_id, status, coalesce(error, '') AS error, description
       FROM [SHOW CHANGEFEED JOBS]
      WHERE status IN ('running', 'paused', 'pending')`,
  );
  return rows;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';

  const client = new Client({
    connectionString: process.env['CORTEX_DSN'],
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();

  try {
    if (command === 'status') {
      const running = await jobs(client);
      if (running.length === 0) {
        console.log('no changefeed jobs running');
        return;
      }
      for (const job of running) {
        console.log(`${job.job_id}  ${job.status}  error=${job.error || 'none'}`);
      }
      return;
    }

    if (command === 'cancel') {
      const id = process.argv[3];
      const targets = id ? [id] : (await jobs(client)).map((j) => j.job_id);
      for (const target of targets) {
        await client.query(`CANCEL JOB ${target}`);
        console.log(`cancelled ${target}`);
      }
      return;
    }

    if (command === 'create') {
      for (const job of await jobs(client)) {
        await client.query(`CANCEL JOB ${job.job_id}`);
        console.log(`cancelled existing ${job.job_id}`);
      }

      const sink = sinkUrl().replace(/^https:\/\//, 'webhook-https://');

      // `updated` puts the commit timestamp on every row, which is what makes the panel
      // able to show a staleness badge rather than guess (`04` §6). `resolved` gives the
      // sink a periodic heartbeat even when nothing changed — the receiver answers 200
      // and emits nothing, which is asserted in `test/demo-stream.test.ts`.
      const { rows } = await client.query<{ job_id: string }>(
        `CREATE CHANGEFEED FOR TABLE ${WATCHED.join(', ')}
           INTO $1
           WITH updated, resolved = '30s', webhook_auth_header = $2`,
        [sink, authHeader()],
      );

      console.log(`created job ${rows[0]?.job_id}`);
      console.log(`sink        ${sink.replace(/^webhook-/, '')}`);
      console.log(`watching    ${WATCHED.join(', ')}`);
      return;
    }

    throw new Error(`unknown command: ${command}. Use status, create or cancel.`);
  } finally {
    await client.end();
  }
}

await main();
