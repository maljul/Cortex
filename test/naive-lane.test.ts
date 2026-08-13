/**
 * U21'S NAMED SILENT BREAK — the naive lane's two transactions collapsing into one.
 *
 * `docs/UNITS.md`: "Design §4.2 makes the naive lane run the same dedupe search and the same
 * claim in *separate* transactions — that split is the entire thing being demonstrated, it is
 * `01` §3's falsification test made executable, and if a refactor ever wraps both in one
 * `withRetry` the naive lane silently becomes the cortex lane. Every row would still be valid
 * and every test would still pass while the demo showed no difference at all."
 *
 * So this file counts transactions, off the same `StatementRecorder` that feeds `05` §5's
 * show-SQL panel. Two `BEGIN` blocks for the naive lane, one for `propose()`, against the real
 * cluster in a real demo scope.
 *
 * It also holds the three structural properties that keep the comparison fair, each of which
 * would otherwise be a claim in a comment:
 *
 * - the naive lane issues the **same** dedupe statement as `propose()`, not a copy of it,
 * - it declares no SQL of its own,
 * - and nothing agent-facing imports it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { byTransaction, StatementRecorder } from '../src/db/recorder.js';
import { createDemoSession } from '../src/memory/demo.js';
import { naiveClaim, naiveDedupeSearch } from '../src/memory/naive-lane.js';
import { DEDUPE_CANDIDATE_SQL, propose } from '../src/memory/propose.js';
import { vector } from './helpers/vectors.js';

const source = (path: string) => readFileSync(path, 'utf8');

async function naiveProposal(sessionId: string, recorder: StatementRecorder, seed: number) {
  const input = {
    repoId: sessionId,
    agentId: `agent-${seed}`,
    statement: `naive lane statement ${seed}`,
    lockKeys: [`task:T${seed}`],
    resourceKeys: [`file:orders/repository.js`],
    embedding: vector(seed),
    plane: 'demo' as const,
    demoSession: sessionId,
    recorder,
  };

  const duplicate = await naiveDedupeSearch(input);
  if (duplicate) return { duplicate, decision: null };
  return { duplicate: null, decision: await naiveClaim(input) };
}

describe('the naive lane splits what the mechanism joins', () => {
  it('issues its dedupe search and its claim in two transactions', async () => {
    const session = await createDemoSession();
    const recorder = new StatementRecorder();

    const result = await naiveProposal(session.sessionId, recorder, 41);
    expect(result.decision?.decision).toBe('granted');

    // Two blocks, and each holds one half of what arbitration does at once. This is the
    // assertion the whole unit turns on: if it ever reads 1, the naive lane has become the
    // cortex lane and the demo is comparing the mechanism against itself.
    const transactions = byTransaction(recorder.statements);
    expect(transactions).toHaveLength(2);

    const [search, claim] = transactions;
    const searchText = search!.statements.map((s) => s.sql).join('\n');
    const claimText = claim!.statements.map((s) => s.sql).join('\n');

    expect(searchText).toContain('embedding <=>');
    expect(searchText).not.toContain('INSERT INTO claims');
    expect(claimText).toContain('INSERT INTO claims');
    expect(claimText).not.toContain('embedding <=>');
  });

  it('propose() issues both in one, which is what invariant 1 means', async () => {
    const session = await createDemoSession();
    const recorder = new StatementRecorder();

    const decision = await propose({
      repoId: session.sessionId,
      agentId: 'agent-1',
      statement: 'the arbitrated statement',
      resourceKeys: ['file:orders/repository.js'],
      embedding: vector(42),
      plane: 'demo',
      demoSession: session.sessionId,
      recorder,
    });
    expect(decision.decision).toBe('granted');

    const transactions = byTransaction(recorder.statements);
    expect(transactions).toHaveLength(1);

    const text = transactions[0]!.statements.map((s) => s.sql).join('\n');
    expect(text).toContain('embedding <=>');
    expect(text).toContain('INSERT INTO claims');
  });

  it('the dedupe search the naive lane runs is the same statement, not a copy', async () => {
    // `06` §2 forbids strawmanning this arm, and the sharpest way to strawman it would be a
    // search that quietly differed — a narrower candidate set, a missing status, a different
    // ordering. Asserted against the recorded text rather than against the import, because
    // what reaches the driver is what the arm actually got.
    const session = await createDemoSession();
    const recorder = new StatementRecorder();

    await naiveProposal(session.sessionId, recorder, 43);

    const searched = recorder.statements.find((s) => s.sql.includes('embedding <=>'));
    // The recorder collapses whitespace on the way to the panel, so both sides are collapsed
    // rather than the expectation being loosened to `toContain`: the claim is that the two
    // arms run the *same statement*, and a substring match would pass on a wider candidate set.
    const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    expect(collapse(searched?.sql ?? '')).toBe(collapse(DEDUPE_CANDIDATE_SQL));
  });

  it('declares no SQL of its own', () => {
    // Every statement is imported from `src/memory/propose.ts`. Two literals would be two
    // places for the arms to drift apart, and the drift would then be reported as a
    // coordination result. Same reasoning as `RECALL_SQL` being pinned to the skill.
    const text = source('src/memory/naive-lane.ts');
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The stripping has to be proved not to have eaten the file — `test/scenario.test.ts`
    // learned that the hard way when its first version flagged its own header.
    expect(withoutComments).toContain('export async function naiveClaim');
    for (const keyword of ['SELECT ', 'INSERT ', 'UPDATE ', 'DELETE ']) {
      expect(withoutComments, `naive-lane.ts writes its own ${keyword.trim()}`).not.toContain(
        keyword,
      );
    }
  });

  it('is unreachable from every agent-facing path', () => {
    // This lane exists to be compared against. An agent that reached it would be arbitrating
    // in two transactions, which is invariant 1 falsified in the one place it matters most.
    for (const path of [
      'src/mcp/server.ts',
      'src/mcp/tools.ts',
      'src/memory/propose.ts',
      'src/memory/close.ts',
      'src/memory/recall.ts',
      'src/memory/consolidate.ts',
    ]) {
      // The *import*, not the mention: `propose.ts` names this file in a comment explaining
      // why its SQL constants are exported, and that comment is worth more than the check
      // being able to be written with `toContain`.
      expect(source(path), `${path} imports the naive lane`).not.toMatch(
        /\bfrom\s+['"][^'"]*naive-lane/,
      );
    }
  });
});
