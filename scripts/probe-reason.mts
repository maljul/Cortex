/**
 * Invokes BEDROCK_REASON_MODEL and prints what comes back.
 *
 *   npm run probe:reason
 *
 * Written because `docs/verification-log.md` recorded the reason model as *entitled*
 * on the strength of `.env` being set and `env:doctor` no longer warning — and this
 * repository has already been bitten twice by exactly that shape of claim (V1's
 * opclass, V5's index isolation, and the Bedrock v5 entitlement itself, which was
 * listed in the catalogue and not entitled). A catalogue listing is not an
 * entitlement; an environment variable is not an invocation. This invokes it.
 *
 * It also pins the request envelope the benchmark's cassette recorder depends on:
 * `anthropic_version: bedrock-2023-05-31`, a `messages` array of content blocks, and
 * `usage.{input_tokens,output_tokens}` on the way back. `bench/reason.ts` sends the
 * same shape, so if Bedrock ever changes it, this fails first and cheaply.
 *
 * Prints no credential and no DSN.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import { REASON_MODEL } from '../bench/reason.js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const modelId = process.env.BEDROCK_REASON_MODEL ?? REASON_MODEL;
const region = process.env.BEDROCK_REGION;

console.log(`model   ${modelId}`);
console.log(`region  ${region ?? '(from the AWS SDK default chain)'}`);

const client = new BedrockRuntimeClient(region === undefined ? {} : { region });

const started = Date.now();

try {
  const response = await client.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 256,
        system: 'Reply with JSON only. No prose, no code fence.',
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Return {"ok": true, "n": 3}' }] }],
      }),
    }),
  );

  const payload = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  console.log(`\nlatency ${Date.now() - started} ms\n`);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
} catch (error) {
  console.error(`\nINVOKE FAILED after ${Date.now() - started} ms`);
  console.error(`${(error as Error).name}: ${(error as Error).message}`);
  console.error(
    '\nAn AccessDeniedException here means the model is listed in the catalogue and ' +
      'not entitled on this account, which is the V-log entry that made this script ' +
      'exist. LIVE reasoning and `npm run bench -- --record` both fail until it is.',
  );
  process.exit(1);
}
