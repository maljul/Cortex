/**
 * The proof harness. `05` §2's `bench` command; spec/06-BENCHMARK-SPEC.md.
 *
 *   npm run bench                        both arms, replayed, at the shipped seed
 *   npm run bench -- --arm=cortex        one arm
 *   npm run bench -- --seed=42           a different deal
 *   npm run bench -- --tasks=6           a subset, for a smoke run
 *   npm run bench -- --json              the run records on stdout
 *   npm run bench -- --record            re-record every cassette against Bedrock
 *
 * `05` §2 asks for `npx cortex bench`. There is no `cortex` binary yet — the CLI is
 * U2, deferred to day three — so this is the same command behind `npm run`. Recorded
 * in docs/SPEC-DELTA.md rather than papered over with a fake binary.
 *
 * Exit codes follow `05` §2: 0 success, 1 error. Neither 10 nor 11 applies — those are
 * one agent's blocked and deduped, and a benchmark run contains many of both.
 */
import { existsSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { runArm, recordCassettes, DEFAULT_SEED } from '../bench/run.js';
import { TASKS } from '../bench/tasks.js';
import type { Arm, RunRecord } from '../bench/types.js';

// U8's lesson: an entry point that does not load .env has no DSN and no region, and
// the failure surfaces a long way from its cause.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const asJson = has('json');
const record = has('record');
const seed = Number(flag('seed') ?? DEFAULT_SEED);
const limit = flag('tasks') === undefined ? undefined : Number(flag('tasks'));
const armFlag = flag('arm') ?? 'both';

if (!['naive', 'cortex', 'both'].includes(armFlag)) {
  console.error(`--arm must be naive, cortex or both; got ${JSON.stringify(armFlag)}`);
  process.exit(1);
}

const tasks = limit === undefined ? TASKS : TASKS.slice(0, limit);
const arms: Arm[] = armFlag === 'both' ? ['naive', 'cortex'] : [armFlag as Arm];

/** One directory per invocation, so two runs never share the NAIVE arm's state file. */
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = join(fileURLToPath(new URL('../bench/runs/', import.meta.url)), runId);

function summarise(record: RunRecord): void {
  const proposals = record.decisions.filter((d) => d.kind === 'propose');
  const outcome = (name: string): number =>
    proposals.filter((d) => d.outcome === name).length;

  const done = record.acknowledged.filter((a) => a.result === 'done');
  const survived = new Set(record.finalState);
  const tokens = record.acknowledged.reduce(
    (total, a) => total + a.tokens.input + a.tokens.output,
    0,
  );

  console.log(`\n${record.arm.toUpperCase()}  seed ${record.seed}  ${record.agents} agents`);
  console.log(`  tasks attempted     ${record.taskIds.length}`);
  console.log(`  acknowledged done   ${done.length}`);
  console.log(`  in final state      ${record.finalState.length}`);
  console.log(`  acknowledged, gone  ${done.filter((a) => !survived.has(a.taskId)).length}`);
  if (record.arm === 'cortex') {
    console.log(`  granted/blocked/deduped  ${outcome('granted')}/${outcome('blocked')}/${outcome('deduped')}`);
  }
  console.log(`  tokens reported     ${tokens}`);
  console.log(`  steps               ${record.decisions.length}`);
  console.log(`  virtual ms          ${record.timings.totalVirtualMs}`);
  console.log(`  wall clock ms       ${record.timings.wallClockMs}`);
  console.log(`  live model calls    embed ${record.cassettes.liveCalls.embed}, reason ${record.cassettes.liveCalls.reason}`);
}

try {
  if (record) {
    console.log(`recording cassettes for ${tasks.length} tasks against Bedrock…`);
    const result = await recordCassettes(tasks);
    console.log(
      `recorded: ${result.tasks} tasks, ${result.embedCalls} embed calls, ` +
        `${result.reasonCalls} reason calls`,
    );
  }

  mkdirSync(runRoot, { recursive: true });
  const records: RunRecord[] = [];

  for (const arm of arms) {
    const runDir = join(runRoot, `${arm}-state`);
    mkdirSync(runDir, { recursive: true });
    const result = await runArm({ arm, seed, tasks, runDir });
    records.push(result);

    writeFileSync(
      join(runRoot, `${arm}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    if (!asJson) summarise(result);
  }

  if (asJson) console.log(JSON.stringify(records, null, 2));
  else console.log(`\nrun records: ${runRoot}`);

  await closePool();
  process.exit(0);
} catch (error) {
  console.error(`\nbench failed: ${(error as Error).message}`);
  await closePool();
  process.exit(1);
}
