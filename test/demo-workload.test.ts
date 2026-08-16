/**
 * THE INTERLOCKS, EXECUTED — "an interlock that merges cleanly and then works anyway is a
 * dead beat, and only running it can tell you which."
 *
 * That is design §12 item 8, and it is the requirement this file exists to satisfy. Design
 * §3.1 engineers five defects so that a worktree-isolated agent fixes each one **correctly in
 * its own branch**, the branch passes, the merge is clean, and the app is still broken. Every
 * word of that is a claim about composed behaviour, and no amount of reading the patches can
 * settle it — two correct changes composing into a wrong result is exactly the thing that
 * looks fine on the page and is wrong on the screen.
 *
 * So this file **runs the app**. `evaluate` — `src/demo/evaluate.ts` since 2026-08-16, so that
 * this test and `bench/demo-app/acceptance.ts` run the same execution rather than two that
 * drift — concatenates a file tree in load order and executes it, then calls the functions a
 * judge's clicks would call. The DOM half (`web/app.js`) is left out because it needs a
 * document and adds nothing here: every interlock is a fact about the modules underneath it.
 *
 * **What each lane's tree means.** The naive lane has the dedupe search and the claim in two
 * transactions and **no `findings` tier** — `06` §2 assigns NAIVE "Consolidation: none" — so
 * its agents are never handed another agent's decision. That is not a handicap bolted on: it
 * is what "a vector store plus a lock service" is, and interlocks 1, 2 and 5 are precisely the
 * gap between dedupe's 0.39 and recall's 0.60. The trees below are built the way the runner
 * builds them, so a change to which patch a lane applies fails here.
 */
import { describe, expect, it } from 'vitest';

import { CONTENDED_FILE, DEMO_TASKS, factOf, patchesFor, taskById } from '../bench/demo-workload.js';
import { APP_FILES } from '../src/demo/app-bundle.js';
import { evaluate, type App } from '../src/demo/evaluate.js';
import { factFromClosedIntent } from '../src/memory/consolidate.js';
import { applyPatch, DEMO_APP_CORPUS, loadFixtureTree, type FileTree } from '../src/demo/patches.js';

function baseline(): FileTree {
  return loadFixtureTree(APP_FILES, DEMO_APP_CORPUS);
}

/** Applies one task's patches, in the variant the named lane would have chosen. */
function withTask(tree: FileTree, id: string, informed = false): FileTree {
  let next = tree;
  for (const patch of patchesFor(id, informed)) next = applyPatch(next, patch);
  return next;
}

/** The banners the detail panel would render for one order — the interlock 4 count. */
function banners(app: App, order: unknown): string[] {
  const sent = (app['confirmationsFor'] as (o: unknown) => string[])(order);
  const body = (app['confirmationBody'] as (o: unknown) => string)(order);
  return body ? [...sent, body] : [...sent];
}

function placeOrder(app: App, sku: string, quantity: number) {
  return (app['submitNewOrder'] as (f: unknown) => { ok: boolean; reason?: string; order?: { id: string } })({
    customer: 'Walk-in',
    sku,
    quantity,
  });
}

describe('the workload agrees with the mechanism it depends on', () => {
  it('factOf produces exactly what the changefeed sink will write', () => {
    // The runner decides an agent is *informed* by comparing recall's returned `fact` against
    // `factOf` the informing task, exactly. So if `03` §4.4's fallback format ever changes,
    // that comparison silently stops matching and both interlocks quietly stop happening —
    // with every other test still green. This is the assertion that turns that into a failure.
    for (const task of DEMO_TASKS) {
      const asSink = factFromClosedIntent({
        statement: task.statement,
        status: task.result,
        outcome: {
          result: task.result,
          ...(task.closureNote ? { notes: task.closureNote } : {}),
        },
      });
      expect(asSink).toBe(factOf(task));
    }
  });

  it('the two halves of the P2 pair consolidate to the same fact', () => {
    // Whichever one the cluster grants must inform C3 identically, or interlock 2 would
    // depend on which agent won a race. `informedBy: 'P2a'` is only sufficient because of this.
    expect(factOf(taskById('P2b'))).toBe(factOf(taskById('P2a')));
  });

  it('every task that can be informed names a task the cut actually contains', () => {
    for (const task of DEMO_TASKS) {
      if (task.informedBy) expect(() => taskById(task.informedBy!)).not.toThrow();
      if (task.sparedBy) expect(() => taskById(task.sparedBy!)).not.toThrow();
      // An informed variant with nothing to inform it is a patch that can never be reached.
      if (task.informedPatches) expect(task.informedBy).toBeTruthy();
    }
  });

  it('I3 authors no closure note, so interlock 1 rides the mechanism rather than the demo', () => {
    // V49: the fallback lands 0.4323 from R3 and the authored alternative 0.4548. The weaker
    // number is the authored one, so there is no reason to author anything — and a note added
    // here later would make the beat depend on the demo's own prose.
    expect(taskById('I3').closureNote).toBeNull();
  });
});

describe('interlock 1 — money representation, lib/money → shipping/quote → web', () => {
  // A-1001 is three lines at 6.17, so 0.75kg: shipping is 2.99 + 0.5 × 0.75 = 3.365 pounds,
  // or 337 minor units. Both numbers are arithmetic, not estimates.
  const order = () => ({ id: 'A-1001', lines: [{ sku: 'SKU-COFFEE', quantity: 3, price: 6.17 }] });

  it('the naive lane renders the shipping line a hundred times too small', () => {
    const tree = withTask(withTask(baseline(), 'I3'), 'R3');
    const app = evaluate(tree);

    const quote = (app['shippingQuote'] as (o: unknown) => number)(order());
    const rendered = (app['formatPrice'] as (n: number) => string)(quote);

    // Neither agent is wrong. I3 moved money to minor units; R3 priced shipping in pounds,
    // which is what a shipping quote is when nobody has told you otherwise.
    expect(quote).toBeCloseTo(3.365, 6);
    expect(rendered).toBe('£0.03');
  });

  it('the cortex lane renders it correctly, because recall carried the decision', () => {
    const tree = withTask(withTask(baseline(), 'I3'), 'R3', true);
    const app = evaluate(tree);

    const quote = (app['shippingQuote'] as (o: unknown) => number)(order());
    expect((app['formatPrice'] as (n: number) => string)(quote)).toBe('£3.37');
  });

  it('and the item total is right in both lanes, so the defect is the shipping line alone', () => {
    // Interlock 1's claim is "the shipping line is 100× off and the totals disagree", not
    // "the money module is broken". If I3 alone were wrong this would be a bug rather than a
    // composition failure, and the argument would change completely.
    for (const informed of [false, true]) {
      const app = evaluate(withTask(withTask(baseline(), 'I3'), 'R3', informed));
      const total = (app['lineTotal'] as (l: unknown) => number)(order().lines[0]!);
      expect((app['formatPrice'] as (n: number) => string)(total)).toBe('£18.51');
    }
  });

  it('the baseline renders the float artefact this ticket exists to remove', () => {
    const app = evaluate(baseline());
    const total = (app['lineTotal'] as (l: unknown) => number)(order().lines[0]!);
    expect((app['formatPrice'] as (n: number) => string)(total)).toBe('£18.509999999999998');
  });
});

describe('interlock 2 — a correct cache and a correct guard, composed', () => {
  // SKU-COFFEE has three in stock. Two orders of two: the first must succeed and the second
  // must not.
  it('the naive lane lets the oversell through with the guard present', () => {
    const tree = withTask(withTask(baseline(), 'P2a'), 'C3');
    const app = evaluate(tree);

    expect(placeOrder(app, 'SKU-COFFEE', 2).ok).toBe(true);
    const second = placeOrder(app, 'SKU-COFFEE', 2);

    // The guard ran. It read a value that was true thirty seconds ago.
    expect(second.ok).toBe(true);
    expect((app['stockOnRecord'] as (s: string) => number)('SKU-COFFEE')).toBe(-1);
  });

  it('the cortex lane refuses it, because recall warned the guard about the cache', () => {
    const tree = withTask(withTask(baseline(), 'P2a'), 'C3', true);
    const app = evaluate(tree);

    expect(placeOrder(app, 'SKU-COFFEE', 2).ok).toBe(true);
    const second = placeOrder(app, 'SKU-COFFEE', 2);

    expect(second.ok).toBe(false);
    expect(second.reason).toContain('insufficient stock');
    expect((app['stockOnRecord'] as (s: string) => number)('SKU-COFFEE')).toBe(1);
  });

  it('both guards refuse an oversell on a cold cache, so neither agent wrote a bug', () => {
    // The sharpest thing about this interlock is that there is no defect to find in either
    // patch. Asked the question they were each asked, both answer correctly.
    for (const informed of [false, true]) {
      const app = evaluate(withTask(withTask(baseline(), 'P2a'), 'C3', informed));
      expect(placeOrder(app, 'SKU-COFFEE', 9).ok).toBe(false);
    }
  });

  it('the cache alone changes nothing a user can see', () => {
    // Interlock 2 is a composition, and this is what makes that literal: P2 without C3 is
    // invisible, and C3 without P2 is correct.
    const cached = evaluate(withTask(baseline(), 'P2a'));
    expect(placeOrder(cached, 'SKU-COFFEE', 2).ok).toBe(true);
    expect((cached['availableStock'] as (s: string) => number)('SKU-COFFEE')).toBe(1);

    const guarded = evaluate(withTask(baseline(), 'C3'));
    expect(placeOrder(guarded, 'SKU-COFFEE', 2).ok).toBe(true);
    expect(placeOrder(guarded, 'SKU-COFFEE', 2).ok).toBe(false);
  });
});

describe('interlock 4 — same work, two modules, clean merge', () => {
  it('the naive lane renders the confirmation twice, identically', () => {
    const tree = withTask(withTask(baseline(), 'P6a'), 'P6b');
    const app = evaluate(tree);

    const placed = placeOrder(app, 'SKU-MUG', 1).order;
    const rendered = banners(app, placed);

    expect(rendered).toHaveLength(2);
    // Identical, not merely both present: two agents doing the same work each produce the
    // whole feature, and the duplication is unmistakable only if the text matches.
    expect(rendered[0]).toBe(rendered[1]);
  });

  it('the cortex lane renders it once, because the second agent stood down', () => {
    const app = evaluate(withTask(baseline(), 'P6a'));
    const placed = placeOrder(app, 'SKU-MUG', 1).order;

    expect(banners(app, placed)).toHaveLength(1);
  });

  it('the two patches touch different files, so no merge strategy would catch it', () => {
    // This is the interlock's whole point and it is one assertion: there is nothing here for
    // a lock, a worktree or a three-way merge to notice.
    const a = patchesFor('P6a').map((p) => p.file);
    const b = patchesFor('P6b').map((p) => p.file);
    expect(a.some((file) => b.includes(file))).toBe(false);
  });
});

describe('interlock 5 — the spared agent leaves no trace in the code', () => {
  it('neither the abandoned task nor the one it spares patches anything', () => {
    // `src/demo/attribution.ts` compares patch text across the two trees, so it correctly
    // reports **nothing** for this interlock. Whoever builds the panel must not present that
    // silence as "no loss": the loss here is a second agent's budget, and it shows in the
    // journey and the token meter or nowhere.
    expect(taskById('A1').patches).toHaveLength(0);
    expect(taskById('T11').patches).toHaveLength(0);
    expect(taskById('T11').sparedBy).toBe('A1');
  });

  it('what A1 embeds names the work, not the obstacle', () => {
    // V39, measured: the abandonReason sits 0.6725–0.7246 from the task it exists to warn
    // and the restatement 0.4698–0.4899. `retrievalKeyFromClosedIntent` is the seam, and this
    // asserts the demo is on the right side of it — A1 closes as `abandoned`, which is the
    // status that selects the restatement as the retrieval key.
    expect(taskById('A1').result).toBe('abandoned');
    expect(factOf(taskById('A1'))).toContain('not available on this account');
  });
});
