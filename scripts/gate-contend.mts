/**
 * Runs the end-of-day-one gate reproducibly: two `contend.mts` processes, a shared
 * start instant, one key, different statements. Asserts exactly one grant and one
 * block, and that the loser named the winner.
 *
 *   npm run gate:contend
 *
 * The manual two-terminal form is what spec/08-BUILD-PLAN.md §3 asks for and is
 * what you should run before believing this. This exists so the gate can be re-run
 * after any change to arbitration without setting up two terminals each time.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const REPO = randomUUID();
const KEY = 'migration:0042';
const LEAD_MS = 3_000;

interface Run {
  agent: string;
  code: number | null;
  out: string;
  parsed: Record<string, any> | undefined;
}

function contend(agent: string, statement: string, at: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      [
        'tsx',
        'scripts/contend.mts',
        '--repo', REPO,
        '--agent', agent,
        '--key', KEY,
        '--statement', statement,
        '--at', String(at),
        '--json',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).at(-1);
      let parsed: Record<string, any> | undefined;
      try {
        parsed = line ? JSON.parse(line) : undefined;
      } catch {
        parsed = undefined;
      }
      resolve({ agent, code, out: out.trim(), parsed });
    });
  });
}

const startAt = Date.now() + LEAD_MS;
console.log(`repo ${REPO}`);
console.log(`key  ${KEY}`);
console.log(`both processes fire at ${new Date(startAt).toISOString()}\n`);

// Different statements on purpose. Identical ones dedupe, which is correct but is
// invariant 4's test, not this gate's.
const runs = await Promise.all([
  contend('agent-1', 'apply migration 0042 to add the accounts index', startAt),
  contend('agent-2', 'roll migration 0042 forward on the billing shard instead', startAt),
]);

for (const run of runs) {
  console.log(`${run.agent}: exit ${run.code} ${run.out}`);
}

const granted = runs.filter((r) => r.parsed?.decision === 'granted');
const blocked = runs.filter((r) => r.parsed?.decision === 'blocked');

const checks: Array<[string, boolean, string]> = [
  ['exactly one agent granted', granted.length === 1, `${granted.length} granted`],
  ['exactly one agent blocked', blocked.length === 1, `${blocked.length} blocked`],
  [
    'the winner exited 0, the loser exited 10',
    granted[0]?.code === 0 && blocked[0]?.code === 10,
    `codes ${runs.map((r) => r.code).join(', ')}`,
  ],
  [
    'the loser named the winner',
    blocked[0]?.parsed?.contested?.[0]?.holder === granted[0]?.parsed?.agent,
    `held by ${blocked[0]?.parsed?.contested?.[0]?.holder ?? '(nobody)'}`,
  ],
  [
    "the loser can reach the winner's intent",
    blocked[0]?.parsed?.contested?.[0]?.intentId === granted[0]?.parsed?.intentId,
    `${blocked[0]?.parsed?.contested?.[0]?.intentId ?? '(none)'}`,
  ],
];

console.log('');
let failed = 0;
for (const [name, ok, evidence] of checks) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${evidence}`);
}

console.log(`\n${failed === 0 ? 'GATE PASS — day two may start.' : `GATE FAIL — ${failed} check(s).`}`);
process.exitCode = failed === 0 ? 0 : 1;
