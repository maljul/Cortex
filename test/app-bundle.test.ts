/**
 * THE BASELINE APP IS DELIBERATELY INCOMPLETE, AND THIS IS WHERE THAT IS PINNED.
 *
 * The demo's argument is that the naive lane finishes with features an agent reported as done
 * and which are not there. That only means anything if the *starting* state provably lacks
 * them — otherwise a passing CORTEX lane could be passing because the feature was there all
 * along.
 *
 * So this file asserts the absences. Each one is a ticket's target, and each is flipped to an
 * assertion of presence by that ticket's patch in `test/demo-workload.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { APP_FILES, assembleApp } from '../src/demo/app-bundle.js';
import { DEMO_APP_CORPUS, loadFixtureTree } from '../src/demo/patches.js';

/** The demo app's files, keyed exactly as `assembleApp` expects them. */
function app() {
  return loadFixtureTree(APP_FILES, DEMO_APP_CORPUS);
}

describe('the corpus assembles into something an iframe can render', () => {
  it('produces one self-contained document', () => {
    const html = assembleApp(app());

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('id="list"');
    expect(html).toContain('function renderOrderList');
  });

  it('loads seven modules in dependency order, with no build step', () => {
    // The corpus is layered on purpose (design §3.1: "which file does this ticket touch"
    // should have a non-obvious answer), and nothing resolves imports for it. So the *order*
    // is the dependency graph: `orders/repository.js` calls `consumeStock`, which only exists
    // because `inventory/repository.js` was parsed first.
    const html = assembleApp(app());
    const at = (marker: string) => html.indexOf(marker);

    expect(at('function stockOnRecord')).toBeLessThan(at('function insertOrder'));
    expect(at('function lineTotal')).toBeLessThan(at('function orderRow'));
    expect(at('function renderStatusPanel')).toBeLessThan(at('function renderDetail'));
    expect(at('function statusHistory')).toBeLessThan(at('function renderStatusPanel'));
  });

  it('reaches no network — nothing to fail, and nothing to leak', () => {
    // `srcdoc` with an external reference would make the two apps depend on the network at
    // the exact moment a judge is looking at them. It would also be the only place on this
    // page that talks to something other than the demo API.
    const html = assembleApp(app());

    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref=/i);
    expect(html).not.toMatch(/\bimport\s+[^(]/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('contains no input element of any kind', () => {
    // Invariant 8 is about the demo *surface*, and since 2026-08-13 an arm's app is part of
    // that surface — it renders inside the page. The app therefore takes every action through
    // a button carrying data attributes, so there is no field on the page for a rule to be
    // argued about. It is also simply better: a judge with thirty seconds clicks.
    const html = assembleApp(app());

    expect(html).not.toMatch(/<input/i);
    expect(html).not.toMatch(/<textarea/i);
    expect(html).not.toMatch(/<form/i);
  });

  it('survives a lane that lost web/app.js entirely', () => {
    // The worst case the naive lane can produce. It must render *something* that shows how
    // much went missing, rather than throwing and blanking the frame — a blank frame reads
    // as a bug in the demo instead of as the result.
    const partial = app();
    delete partial['web/app.js'];

    const html = assembleApp(partial);
    expect(html).toContain('id="list"');
    expect(html).not.toContain('function renderDetail');
    expect(html).toContain('typeof start === "function"');
  });
});

/**
 * The corpus was fifteen files of four hundred to sixteen hundred bytes until 2026-08-16, and
 * every ticket against it was answerable by reading one function. That is fine while the
 * patches are committed and fatal the moment an agent authors the code: a ticket a model
 * finishes in one glance produces the same answer every run, and a demo whose outcome never
 * varies reads as a recording.
 *
 * These are the properties that make the tickets worth a model's attention, and they are here
 * because prose in a README is not a check.
 */
describe('the corpus is deep enough that a ticket is real work', () => {
  /** Every module a ticket names, or has to be read to answer one. */
  const TICKET_MODULES = [
    'lib/money.js', 'inventory/repository.js', 'orders/repository.js', 'orders/list.js',
    'orders/status.js', 'orders/create.js', 'shipping/quote.js', 'notify/templates.js',
    'notify/email.js', 'payments/provider.js',
  ];

  it('every module a ticket touches has enough in it to be read', () => {
    // A floor rather than a range. The point is that these are modules with behaviour —
    // validation, edge cases, formatting, error paths — and not four functions and a comment
    // saying what a ticket will do to them.
    const tree = app();
    const tooThin = TICKET_MODULES.map((file) => ({
      file,
      lines: (tree[file] ?? '').split('\n').length,
    })).filter((module) => module.lines < 90);

    expect(tooThin).toEqual([]);
  });

  it('the answer to a ticket is not inside the file the ticket names', () => {
    // Each pair is a module and a name it depends on that is **defined somewhere else**. This
    // is the property design §3.1 asks for — every interlock crosses a module boundary — made
    // checkable: a corpus flattened back into self-contained files fails here.
    const DEPENDS_ON: [string, string][] = [
      ['lib/money.js', 'CURRENCY'],
      ['lib/money.js', 'taxRateOf'],
      ['inventory/repository.js', 'catalogueSkus'],
      ['orders/repository.js', 'STATUS_FLOW'],
      ['orders/repository.js', 'consumeStock'],
      ['orders/list.js', 'lineTotal'],
      ['orders/list.js', 'pluralise'],
      ['orders/status.js', 'STATUS_RANK'],
      ['orders/status.js', 'nextStatusesFor'],
      ['orders/create.js', 'insertOrder'],
      ['orders/create.js', 'notifyOrderPlaced'],
      ['shipping/quote.js', 'SHIPPING_TARIFF'],
      ['shipping/quote.js', 'weightOf'],
      ['notify/templates.js', 'formatPrice'],
      ['notify/templates.js', 'deliveryEstimateDays'],
      ['notify/email.js', 'subjectFor'],
      ['payments/provider.js', 'orderSubtotal'],
    ];

    const tree = app();
    const definedIn = (name: string) =>
      Object.keys(tree).filter(
        (file) =>
          (tree[file] ?? '').includes(`function ${name}(`) ||
          (tree[file] ?? '').includes(`var ${name} =`),
      );

    const broken = DEPENDS_ON.filter(([file, name]) => {
      const where = definedIn(name);
      return !(tree[file] ?? '').includes(name) || where.length !== 1 || where[0] === file;
    });

    expect(broken).toEqual([]);
  });

  it('carries no module syntax of any kind, so it needs no build step', () => {
    // `assembleApp` concatenates these files into one `srcdoc` document and
    // `src/demo/evaluate.ts` runs them through `new Function`. Either would break silently on a
    // module keyword — the iframe renders blank with no error — so the absence is asserted
    // against the files rather than only against the assembled document.
    const offenders = Object.entries(app()).filter(
      ([, source]) =>
        /^\s*(import|export)\s/m.test(source) ||
        /\brequire\s*\(/.test(source) ||
        /\bmodule\.exports\b/.test(source),
    );

    expect(offenders.map(([file]) => file)).toEqual([]);
  });
});

describe('the baseline lacks every feature the tickets add', () => {
  const source = () => Object.values(app()).join('\n');

  it('has no pagination — C1 adds it', () => {
    // Asserted against `orders/list.js` and not the whole bundle: `web/styles.css` already
    // carries a `.pager` rule, the way a real stylesheet carries rules for the whole design
    // rather than only for what is built today. The *feature* lives in the list view and the
    // store, and that is where its absence has to be true.
    // `renderPager` itself exists in the baseline and returns a row count, so the absence to
    // assert is the pager *chrome*, not the function name. C1 adds the nav.
    expect(app()['orders/list.js']).toContain('function renderPager');
    expect(app()['orders/list.js']).not.toContain('class="pager"');
    expect(app()['orders/repository.js']).not.toContain('ORDERS_PER_PAGE');
    expect(app()['web/styles.css']).toContain('.pager');
  });

  it('records no status history — C2 adds it', () => {
    // The store declares the map and never writes to it, and the panel says so. Both halves
    // are C2's, in two modules.
    expect(source()).toContain('var STATUS_HISTORY = {}');
    expect(source()).not.toContain('STATUS_HISTORY[id].push');
    expect(source()).not.toContain('class="timeline"');
  });

  it('does not check stock — C3 adds it', () => {
    // `availableStock` exists and nothing calls it. That is the ticket.
    expect(source()).toContain('function availableStock');
    expect(source()).not.toContain('insufficient stock');
  });

  it('caches nothing — P2 adds it', () => {
    expect(source()).toContain('function stockOnRecord');
    expect(source()).not.toContain('STOCK_CACHE');
  });

  it('sends no confirmation — P6a and P6b add it', () => {
    expect(app()['notify/email.js']).toContain('return null;');
    expect(app()['notify/templates.js']).toContain("return '';");
  });

  it('prices no shipping — R3 adds it', () => {
    expect(app()['shipping/quote.js']).toContain('return 0;');
  });

  it('renders prices straight off a float — I3 fixes it', () => {
    // The visible symptom, measured rather than assumed — and an earlier version of this test
    // assumed wrong. `2 * 6.17` **is** exactly 12.34 in binary floating point, so an order of
    // two proves nothing. A-1001 is three lines at 6.17, which renders as
    // `£18.509999999999998` on screen, straight off the float.
    //
    // The formatter renders what it is handed and scales nothing; the absence to assert is the
    // scaling, because `lib/money.js` has carried `toMinorUnits` all along and nothing calls it
    // on the way to the screen.
    expect(app()['lib/money.js']).toContain('return CURRENCY.symbol + amount;');
    expect(app()['lib/money.js']).toContain('function toMinorUnits');
    expect(app()['lib/money.js']).not.toContain('minorUnits / 100');
    expect(String(2 * 6.17)).toBe('12.34');
    expect(String(3 * 6.17)).toBe('18.509999999999998');
  });

  it('cannot be completed by accident — the provider dead end has no patch to apply', () => {
    // A1 and T11 are impossible, so this file is identical in both lanes for ever. Asserted
    // here because "no ticket touches it" is a property of the corpus that would otherwise be
    // recorded only in prose.
    expect(app()['payments/provider.js']).toContain('return 2;');
    expect(app()['payments/provider.js']).toContain('refunds are manual');
  });
});
