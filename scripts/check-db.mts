/**
 * Answers one question: can we reach the cluster named by CORTEX_DSN, and if not,
 * what did it actually say?
 *
 *   npm run db:check
 *
 * Reports the SHAPE of the DSN — host, port, database, sslmode, whether a password
 * is present — and never the DSN or the password itself, so the output is safe to
 * paste into an issue or a chat.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ENV_PATH = resolve(process.cwd(), '.env');

if (existsSync(ENV_PATH)) {
  process.loadEnvFile(ENV_PATH);
} else {
  console.error(`no .env at ${ENV_PATH}`);
  process.exit(1);
}

const dsn = process.env.CORTEX_DSN;

if (dsn === undefined || dsn.trim() === '') {
  console.error(
    `CORTEX_DSN is ${dsn === undefined ? 'missing from' : 'empty in'} .env.\n\n` +
      'Get it from cockroachlabs.cloud -> your cluster -> Connect -> General connection\n' +
      'string, then add it to .env wrapped in single quotes:\n\n' +
      "  CORTEX_DSN='postgresql://user:pass@host.cockroachlabs.cloud:26257/defaultdb?sslmode=verify-full'\n\n" +
      'Quote it: process.loadEnvFile is not dotenv and truncates at an unquoted "#".',
  );
  process.exit(1);
}

let url: URL;
try {
  url = new URL(dsn);
} catch {
  console.error(
    `CORTEX_DSN is not a valid URL (${dsn.length} chars, starts ${JSON.stringify(dsn.slice(0, 12))}).\n` +
      'Expected postgresql://user:password@host:26257/database?sslmode=verify-full',
  );
  process.exit(1);
}

console.log('DSN shape');
console.log(`  host     ${url.hostname}${url.port ? `:${url.port}` : ''}`);
console.log(`  user     ${url.username || '(none)'}`);
console.log(`  password ${url.password ? `present (${url.password.length} chars)` : 'MISSING'}`);
console.log(`  database ${url.pathname.replace(/^\//, '') || '(none)'}`);
console.log(`  params   ${JSON.stringify(Object.fromEntries(url.searchParams))}`);

if (url.username === 'user' || url.password === 'password' || url.hostname === 'host') {
  console.error('\nThis is still the .env.example placeholder, not a real connection string.');
  process.exit(1);
}
if (!url.searchParams.has('sslmode')) {
  console.log('\nnote: no sslmode. CockroachDB Cloud expects ?sslmode=verify-full');
}

const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10_000 });

try {
  const started = Date.now();
  await client.connect();
  console.log(`\nconnected in ${Date.now() - started}ms`);

  const { rows } = await client.query(
    'SELECT version() AS version, current_user AS "user", current_database() AS database',
  );
  const row = rows[0] as { version: string; user: string; database: string };
  console.log(`  user     ${row.user}`);
  console.log(`  database ${row.database}`);
  console.log(`  version  ${row.version}`);

  // 001_init.sql line 6 is SET CLUSTER SETTING, so a refusal here stops the schema
  // before it creates a single table. Worth knowing now rather than mid-migration.
  try {
    await client.query('SET CLUSTER SETTING feature.vector_index.enabled = true');
    console.log('\nvector index setting: allowed');
  } catch (error) {
    const e = error as { code?: string; message?: string };
    console.log(`\nvector index setting: REFUSED (${e.code}) ${e.message}`);
    console.log('  This is V1 failing. See spec/04-ARCHITECTURE.md section 8 for the fallback.');
  }

  console.log('\nOK. Next: npm run sql -- sql/000_verify.sql --only 1-5');
} catch (error) {
  const e = error as NodeJS.ErrnoException & { severity?: string; detail?: string; hint?: string };
  console.error('\nCONNECTION FAILED');
  console.error(`  code    ${e.code ?? '(none)'}`);
  console.error(`  message ${e.message}`);
  if (e.detail) console.error(`  detail  ${e.detail}`);
  if (e.hint) console.error(`  hint    ${e.hint}`);

  const advice: Record<string, string> = {
    ENOTFOUND: 'Host does not resolve. Re-copy the string from the Console.',
    ETIMEDOUT: 'No response. The cluster may be paused, or your IP is not on the allowlist.',
    ECONNREFUSED: 'Nothing listening. Check the port is 26257.',
    '28P01': 'Password rejected. Reset it in the Console under SQL Users.',
    '3D000': 'That database does not exist. A fresh cluster only has defaultdb.',
    '08006': 'Connection dropped. Often a paused cluster resuming — try once more.',
  };
  const hint = advice[e.code ?? ''];
  if (hint) console.error(`\n  ${hint}`);

  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
