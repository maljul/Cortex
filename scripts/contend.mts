/**
 * One agent, one process, one claim attempt. This is the end-of-day-one gate in
 * spec/08-BUILD-PLAN.md §3: "two processes in two terminals contend for one key,
 * one wins, the loser prints the winner's identity."
 *
 * Run it twice, in two terminals, against the same --repo and --key:
 *
 *   npm run contend -- --repo <uuid> --agent agent-1 --statement "..." --at <epoch_ms>
 *
 * Or let the runner do it: npm run gate:contend
 *
 * Why a separate process matters. The test suite already proves two concurrent
 * SERIALIZABLE transactions arbitrate correctly, but they share a pool, a client
 * library and an event loop. Two processes share nothing except the cluster, which
 * is the claim the design actually makes — mutual exclusion lives in the uniqueness
 * of (repo_id, resource_key), not in anything a single process coordinates.
 *
 * Exit codes are spec/05-INTERFACES.md §2: 0 granted, 10 blocked, 11 deduped,
 * 1 error. Distinct codes let a shell-driven agent branch without parsing output.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { Embedder } from '../src/embed/titan.js';
import { propose } from '../src/memory/propose.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const repo = arg('repo');
const agent = arg('agent');
const key = arg('key') ?? 'file:src/auth/login.ts';
const statement = arg('statement');
const startAt = arg('at') === undefined ? undefined : Number(arg('at'));
const json = process.argv.includes('--json');

if (!repo || !agent || !statement) {
  console.error(
    'usage: npm run contend -- --repo <uuid> --agent <id> --statement "<what you intend to do>"\n' +
      '                        [--key file:src/auth/login.ts] [--at <epoch_ms>] [--json]\n\n' +
      'Two agents must give DIFFERENT statements. Identical ones dedupe rather than\n' +
      'contend, which is correct behaviour but not what this gate is testing.',
  );
  process.exit(1);
}

/** Prints only in human mode, so --json output stays machine-parseable. */
function say(line: string): void {
  if (!json) console.log(line);
}

try {
  say(`${agent}: embedding`);
  const embedding = await new Embedder().embed(statement);

  // Both processes fire at the same wall-clock instant. Without this the second
  // process starts a round-trip behind and the race is decided by process startup
  // time rather than by the cluster.
  if (startAt !== undefined) {
    const wait = startAt - Date.now();
    if (wait > 0) {
      say(`${agent}: waiting ${wait}ms for the shared start`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const began = Date.now();
  const result = await propose({
    repoId: repo,
    agentId: agent,
    statement,
    resourceKeys: [key],
    embedding,
  });
  const took = Date.now() - began;

  if (json) {
    console.log(JSON.stringify({ agent, key, took, ...result }));
  } else if (result.decision === 'granted') {
    console.log(`\n${agent}: GRANTED ${key} in ${took}ms`);
    console.log(`  intent  ${result.intentId}`);
    console.log(`  expires ${result.expiresAt.toISOString()}`);
  } else if (result.decision === 'blocked') {
    console.log(`\n${agent}: BLOCKED in ${took}ms`);
    for (const c of result.contested) {
      // The whole point of the gate: the loser names the winner rather than polling.
      console.log(`  ${c.resourceKey} is held by ${c.holder}`);
      console.log(`    their intent ${c.intentId}, until ${c.expiresAt.toISOString()}`);
    }
    console.log('  Re-plan around these keys. Do not retry.');
  } else {
    console.log(`\n${agent}: DEDUPED in ${took}ms`);
    console.log(`  ${agent} is doing what ${result.holder} already ${result.status}`);
    console.log(`  their intent ${result.of}, distance ${result.distance.toFixed(4)}`);
    console.log(`  outcome ${JSON.stringify(result.outcome)}`);
  }

  process.exitCode = { granted: 0, blocked: 10, deduped: 11 }[result.decision];
} catch (error) {
  const e = error as { message?: string; code?: string };
  console.error(`${agent}: ERROR ${e.code ?? ''} ${e.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
