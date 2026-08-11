/**
 * Uploads `infra/site/` to the stack's bucket and invalidates CloudFront.
 *
 *   npx tsx scripts/deploy-site.mts
 *
 * The page needs two endpoints it cannot know when it is written — the HTTP API's URL and
 * the WebSocket stage's — because both are CloudFormation outputs. They are injected here
 * as a small `window.CORTEX_*` preamble rather than fetched from a config route, which
 * would cost every visitor a round trip before the page could do anything.
 *
 * **Neither value is a credential**, and it matters that this is said out loud on the one
 * step that writes values into a public artifact: both are public endpoints that `05` §5
 * requires anyone to be able to call anonymously. The rule that no credential reaches the
 * browser is not in tension with this; it is why the injected preamble is two URLs and
 * nothing else, and why this script reads the stack's outputs rather than `.env`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STACK = 'CortexStack';

function aws(args: string[]): string {
  const result = spawnSync('aws', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`aws ${args[0]} ${args[1]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function outputs(): Record<string, string> {
  const raw = aws([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    STACK,
    '--query',
    'Stacks[0].Outputs',
    '--output',
    'json',
  ]);

  const entries = JSON.parse(raw) as { OutputKey: string; OutputValue: string }[];
  return Object.fromEntries(entries.map((o) => [o.OutputKey, o.OutputValue]));
}

const stack = outputs();
const bucket = stack['BucketName'];
const api = stack['ApiUrl'];
const stream = stack['StreamUrl'];

if (!bucket || !api || !stream) {
  throw new Error(`${STACK} is missing BucketName / ApiUrl / StreamUrl. Deploy it first.`);
}

const source = resolve('infra/site/index.html');
const preamble = [
  '<script>',
  `  window.CORTEX_API_URL = ${JSON.stringify(api)};`,
  `  window.CORTEX_STREAM_URL = ${JSON.stringify(stream)};`,
  '</script>',
  '',
].join('\n');

const staging = mkdtempSync(join(tmpdir(), 'cortex-site-'));
const page = join(staging, 'index.html');
writeFileSync(page, preamble + readFileSync(source, 'utf8'));

aws(['s3', 'cp', page, `s3://${bucket}/index.html`, '--content-type', 'text/html; charset=utf-8']);

const distribution = aws([
  'cloudfront',
  'list-distributions',
  '--query',
  `DistributionList.Items[?Origins.Items[?contains(DomainName, '${bucket}')]].Id`,
  '--output',
  'text',
]);

if (distribution) {
  aws(['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', '/*']);
}

console.log(`uploaded  s3://${bucket}/index.html`);
console.log(`api       ${api}`);
console.log(`stream    ${stream}`);
console.log(`site      ${stack['SiteUrl']}`);
console.log(distribution ? `invalidated ${distribution} /*` : 'no distribution found to invalidate');
