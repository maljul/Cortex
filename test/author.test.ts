/**
 * WHAT A MODEL IS ALLOWED TO PUT INTO THE CORPUS.
 *
 * `src/demo/author.ts` is the seam where the demo stops reciting committed code and starts
 * letting a model write it. That is the change that makes a run's outcome vary, and it is also
 * the change that hands an external, non-deterministic process a path to the bytes a judge will
 * see running in an iframe. Every assertion below exists because that path has to be narrower
 * than the model is.
 *
 * The rule this file enforces: **a model output reaches the corpus only if it names a file the
 * agent was given, anchors uniquely in the bytes the agent read, and compiles.** Anything else
 * falls back to the reviewed committed patch, and the fallback is reported rather than hidden —
 * `07` §1 makes every rendered figure a claim, and "the model wrote this" is a claim.
 *
 * **These tests are written to be able to fail.** Each rejection case is paired with the same
 * input made valid, so a `validateEdits` that returned a rejection for everything would fail
 * this file rather than pass it. That symmetry is the point: a validator that cannot accept is
 * as broken as one that cannot refuse, and only the accepting half proves the refusing half was
 * doing work.
 *
 * Nothing here reaches Bedrock. `modelAuthor` takes an injected `invoke`, so the fallback
 * behaviour — the half that decides whether a judge ever sees an error — is driven directly
 * rather than waited for.
 */
import { describe, expect, it } from 'vitest';

import {
  committedAuthor,
  modelAuthor,
  validateEdits,
  type AuthorRequest,
} from '../src/demo/author.js';
import type { FileTree, Patch } from '../src/demo/patches.js';

const FILES: FileTree = {
  'lib/money.js': [
    'function formatPrice(minorUnits) {',
    '  return (minorUnits / 100).toFixed(2);',
    '}',
  ].join('\n'),
  'orders/list.js': [
    'function allOrders() {',
    '  return ORDERS;',
    '}',
  ].join('\n'),
};

const COMMITTED: Patch[] = [
  { file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS.slice(0, 10);' },
];

function request(overrides: Partial<AuthorRequest> = {}): AuthorRequest {
  return {
    taskId: 'C1',
    statement: 'Paginate the orders list',
    agent: 'agent-1',
    files: FILES,
    findings: [],
    ...overrides,
  };
}

/** The committed author, which is also `modelAuthor`'s fallback on every rejection path. */
const fallback = committedAuthor(() => [...COMMITTED]);

describe('validateEdits — what a model may and may not put into the corpus', () => {
  it('accepts a well-formed edit that anchors uniquely and compiles', () => {
    const result = validateEdits(
      { edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS.slice(0, 10);' }] },
      FILES,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS.slice(0, 10);' },
    ]);
  });

  it('accepts several edits that compose into one still-parsing file', () => {
    const result = validateEdits(
      {
        edits: [
          { file: 'lib/money.js', find: 'function formatPrice(minorUnits) {', replace: 'function formatPrice(minorUnits, currency) {' },
          { file: 'lib/money.js', find: '  return (minorUnits / 100).toFixed(2);', replace: '  return currency + (minorUnits / 100).toFixed(2);' },
        ],
      },
      FILES,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it('refuses a response that is not JSON at all', () => {
    expect(typeof validateEdits(null, FILES)).toBe('string');
    expect(typeof validateEdits('sure, here is the patch', FILES)).toBe('string');
  });

  it('refuses a response carrying no edits', () => {
    expect(validateEdits({ edits: [] }, FILES)).toContain('no edits');
    expect(typeof validateEdits({ note: 'done!' }, FILES)).toBe('string');
  });

  it('refuses an edit missing file, find or replace', () => {
    expect(typeof validateEdits({ edits: [{ file: 'orders/list.js', find: 'x' }] }, FILES)).toBe('string');
  });

  /**
   * The boundary that matters most. A model naming a path it was not handed is the one failure
   * mode with reach beyond a broken demo, so it is refused by identity against the read set
   * rather than by pattern — no prefix check, no traversal filter, no allow-list to drift.
   */
  it('refuses a file the agent was never given, however plausible the path', () => {
    for (const file of ['orders/repository.js', '../../.env', '/etc/passwd', 'lib/money.js.bak']) {
      const verdict = validateEdits(
        { edits: [{ file, find: 'anything', replace: 'anything' }] },
        FILES,
      );
      expect(typeof verdict, `${file} must be refused`).toBe('string');
      expect(verdict as string).toContain('not given');
    }
  });

  it('refuses a hallucinated anchor', () => {
    const verdict = validateEdits(
      { edits: [{ file: 'orders/list.js', find: 'function neverWritten() {', replace: 'x' }] },
      FILES,
    );
    expect(verdict).toContain('anchor not found');
  });

  /**
   * An ambiguous anchor is refused. **This assertion does not isolate which layer refuses it**,
   * and mutation testing is how that was established rather than assumed: deleting the check in
   * `validateEdits` leaves all 19 tests green, because `applyPatch` refuses the same case with a
   * message carrying the same words. The two layers are genuine defence in depth — the behaviour
   * survives losing either — but no test here can tell them apart, so nothing above claims one.
   */
  it('refuses an anchor that appears more than once', () => {
    const repeated: FileTree = { 'a.js': 'var x = 1;\nvar x = 1;\n' };
    const verdict = validateEdits(
      { edits: [{ file: 'a.js', find: 'var x = 1;', replace: 'var x = 2;' }] },
      repeated,
    );
    expect(verdict).toContain('more than once');
  });

  it('refuses an empty anchor, which would otherwise match at position zero', () => {
    expect(typeof validateEdits({ edits: [{ file: 'orders/list.js', find: '', replace: 'x' }] }, FILES)).toBe('string');
  });

  /**
   * The compile check. This is what stands between a model's bad day and a blank iframe: the
   * page assembles the tree with no build step, so a syntax error renders as nothing at all,
   * with no error anywhere a visitor or a test could see it.
   */
  it('refuses authored source that does not parse, naming the file', () => {
    const verdict = validateEdits(
      { edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS[[[;' }] },
      FILES,
    );
    expect(verdict).toContain('does not parse');
    expect(verdict).toContain('orders/list.js');
  });

  /**
   * **What the compile check does not catch, asserted so nobody reads more into it than it says.**
   *
   * `return }{;` inside a function body is *valid JavaScript*: ASI terminates the `return`, the
   * `}` closes the function, and `{;}` is a bare block. It parses, and it is obviously not what
   * the ticket asked for. This was written as a rejection case and passed as an acceptance one,
   * which is the useful way to find out. The check answers "is this syntactically valid", and
   * that is all it answers — semantic nonsense is caught downstream by the acceptance oracle
   * executing the composed app, never here.
   */
  it('accepts syntactically valid nonsense, because parsing is all a parse check can decide', () => {
    const result = validateEdits(
      { edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return }{;' }] },
      FILES,
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it('refuses a pair of edits that each anchor but together stop parsing', () => {
    const verdict = validateEdits(
      {
        edits: [
          { file: 'lib/money.js', find: 'function formatPrice(minorUnits) {', replace: 'function formatPrice(minorUnits) {' },
          { file: 'lib/money.js', find: '}', replace: '' },
        ],
      },
      FILES,
    );
    expect(typeof verdict).toBe('string');
  });
});

describe('committedAuthor — the replay path', () => {
  it('reports its source and spends nothing', async () => {
    const result = await fallback(request());
    expect(result.source).toBe('committed');
    expect(result.usage).toBeNull();
    expect(result.patches).toEqual(COMMITTED);
  });
});

describe('modelAuthor — authored when it validates, reviewed code when it does not', () => {
  it('returns the model’s edits, its usage and its note when the answer is good', async () => {
    const author = modelAuthor({
      fallback,
      invoke: async () => ({
        text: JSON.stringify({
          edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS.slice(0, 10);' }],
          note: 'paginated the list',
        }),
        inputTokens: 1200,
        outputTokens: 90,
      }),
    });

    const result = await author(request());
    expect(result.source).toBe('model');
    expect(result.patches[0]!.replace).toContain('slice(0, 10)');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
    expect(result.note).toBe('paginated the list');
  });

  it('tolerates a markdown fence, because Haiku emits one by default', async () => {
    const author = modelAuthor({
      fallback,
      invoke: async () => ({
        text: '```json\n' + JSON.stringify({
          edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS.slice(0, 5);' }],
          note: 'fenced',
        }) + '\n```',
        inputTokens: 10,
        outputTokens: 10,
      }),
    });

    const result = await author(request());
    expect(result.source).toBe('model');
    expect(result.patches[0]!.replace).toContain('slice(0, 5)');
  });

  /**
   * The behaviour a judge depends on without knowing it. `04` §5 invariant 1 admits no error
   * page on a path behind the run button, so every rejection has to end in the agent still
   * doing its ticket — with the reviewed patch, and saying so.
   */
  it('falls back to the committed patch on every rejection, and never throws', async () => {
    const badAnswers = [
      'not json at all',
      JSON.stringify({ edits: [] }),
      JSON.stringify({ edits: [{ file: 'secrets.js', find: 'a', replace: 'b' }] }),
      JSON.stringify({ edits: [{ file: 'orders/list.js', find: 'nope', replace: 'b' }] }),
      JSON.stringify({ edits: [{ file: 'orders/list.js', find: '  return ORDERS;', replace: '  return ORDERS[[[;' }] }),
    ];

    for (const text of badAnswers) {
      const rejected: string[] = [];
      const author = modelAuthor({
        fallback,
        onReject: (reason) => rejected.push(reason),
        invoke: async () => ({ text, inputTokens: 5, outputTokens: 5 }),
      });

      const result = await author(request());
      expect(result.source, `"${text.slice(0, 40)}" must fall back`).toBe('fallback');
      expect(result.patches).toEqual(COMMITTED);
      expect(rejected).toHaveLength(1);
      expect(result.note).toContain('reviewed patch');
    }
  });

  it('falls back when the call itself throws, and still reports the ticket’s patches', async () => {
    const author = modelAuthor({
      fallback,
      invoke: async () => { throw new Error('ThrottlingException'); },
    });

    const result = await author(request());
    expect(result.source).toBe('fallback');
    expect(result.patches).toEqual(COMMITTED);
    expect(result.note).toContain('ThrottlingException');
    // No call completed, so there is nothing to bill and nothing to report.
    expect(result.usage).toBeNull();
  });

  /**
   * The abandoned ticket writes nothing, and must not spend a call to discover that. This is
   * both a cost assertion and a correctness one: A1 is abandoned on purpose, and a model asked
   * to patch a ticket with no patches would invent one.
   */
  it('never calls the model for a ticket that has no patches to write', async () => {
    let calls = 0;
    const author = modelAuthor({
      fallback: committedAuthor(() => []),
      invoke: async () => { calls += 1; return { text: '{}', inputTokens: 0, outputTokens: 0 }; },
    });

    const result = await author(request({ taskId: 'A1' }));
    expect(calls).toBe(0);
    expect(result.patches).toEqual([]);
    expect(result.usage).toBeNull();
  });

  /**
   * The asymmetry between the arms, asserted at the only place it exists. The naive lane is not
   * handicapped: same model, same statement, same files, same ceiling. It is handed no findings
   * because that stack has no verb with which to ask for them.
   */
  it('puts recalled findings in the prompt, and puts nothing else there for the naive lane', async () => {
    const prompts: string[] = [];
    const capture = modelAuthor({
      fallback,
      invoke: async (prompt) => {
        prompts.push(prompt);
        return { text: 'not json', inputTokens: 0, outputTokens: 0 };
      },
    });

    await capture(request({ findings: [] }));
    await capture(request({
      findings: [{
        fact: 'money is carried in integer minor units',
        confidence: 0.9,
        distance: 0.36,
        timesReverted: 2,
        lastTouched: null,
      }],
    }));

    const [naivePrompt, cortexPrompt] = prompts;
    expect(naivePrompt).not.toContain('ALREADY KNOWS');
    expect(cortexPrompt).toContain('money is carried in integer minor units');
    expect(cortexPrompt).toContain('reverted 2 time(s)');

    // Same ticket, same corpus: the only difference is the fact the fleet paid to learn.
    expect(naivePrompt!.includes(FILES['orders/list.js']!)).toBe(true);
    expect(cortexPrompt!.includes(FILES['orders/list.js']!)).toBe(true);
    expect(naivePrompt).toContain('Paginate the orders list');
    expect(cortexPrompt).toContain('Paginate the orders list');
  });
});
