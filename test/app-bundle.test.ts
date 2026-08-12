/**
 * THE BASELINE APP IS DELIBERATELY INCOMPLETE, AND THIS IS WHERE THAT IS PINNED.
 *
 * The demo's argument is that the naive lane finishes with features an agent reported as done
 * and which are not there. That only means anything if the *starting* state provably lacks
 * them — otherwise a passing CORTEX lane could be passing because the feature was there all
 * along.
 *
 * So this file asserts the absences. Each one is a ticket's target, and each will be flipped
 * to an assertion of presence by that ticket's patch in `bench/demo-workload.ts`.
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
    expect(html).toContain('function renderList');
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

  it('survives a lane that lost app.js entirely', () => {
    // The worst case the naive lane can produce. It must render *something* that shows how
    // much went missing, rather than throwing and blanking the frame — a blank frame reads
    // as a bug in the demo instead of as the result.
    const partial = app();
    delete partial['app.js'];

    const html = assembleApp(partial);
    expect(html).toContain('id="list"');
    expect(html).not.toContain('function renderList');
  });
});

describe('the baseline lacks every feature the tickets add', () => {
  const source = () => Object.values(app()).join('\n');

  it('has no pagination — C1 adds it', () => {
    // Asserted against `app.js` and not the whole bundle: `styles.css` already carries a
    // `.pager` rule, the way a real stylesheet carries rules for the whole design rather
    // than only for what is built today. The *feature* lives in `app.js`, and that is where
    // its absence has to be true.
    expect(app()['app.js']).not.toContain('pager');
    expect(app()['styles.css']).toContain('.pager');
  });

  it('records no status history — C2 adds it', () => {
    expect(source()).toContain('No history recorded.');
    expect(source()).not.toContain('class="timeline"');
  });

  it('does not check stock — C3 adds it', () => {
    // `availableStock` exists and nothing calls it. That is the ticket.
    expect(source()).toContain('function availableStock');
    expect(source()).not.toContain('insufficient stock');
  });

  it('sends no confirmation — P6a and P6b add it', () => {
    expect(source()).toContain('function notifyOrderPlaced');
    expect(source()).toContain('return null;');
    expect(source()).toContain('function confirmationBody');
  });

  it('renders prices straight off a float — I3 fixes it', () => {
    // The visible symptom, measured rather than assumed — and the first version of this
    // test assumed wrong. `2 * 6.17` **is** exactly 12.34 in binary floating point, so
    // order A-1001 renders fine and proves nothing. A-1003 is the one that breaks: three
    // lines at 4.05 render as `£12.149999999999999` on screen, straight off the float.
    expect(source()).toContain("return '£' + amount;");
    expect(String(2 * 6.17)).toBe('12.34');
    expect(String(3 * 4.05)).toBe('12.149999999999999');
  });
});
