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
    expect(app()['lib/money.js']).toContain("return '£' + amount;");
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
