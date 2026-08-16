/**
 * THE DEMO PAGE — spec/03-MEMORY-MODEL.md §8 invariant 8, spec/07 §4, spec/05 §5.
 *
 * Invariant 8 is "no credential field on any demo surface, under any name, including
 * commented out or feature-flagged off", and this page is the surface it was written
 * about. `07` §4 states the reasoning plainly: the hazard is not that a judge would supply
 * a credential, it is that once the field exists on a public page somebody eventually
 * pastes a live production key into it, and you own that.
 *
 * A rule like that regresses the day someone adds "just a debug field" — so it is checked
 * rather than trusted. The file is read as text, so a field that is present but hidden,
 * disabled, or sitting inside a comment fails exactly as loudly as a visible one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const page = readFileSync(
  fileURLToPath(new URL('../infra/site/index.html', import.meta.url)),
  'utf8',
);

describe('the demo page accepts nothing from the visitor — invariant 8', () => {
  it.each(['<input', '<form', '<textarea', '<select', 'contenteditable'])(
    'contains no %s anywhere, including commented out',
    (element) => {
      expect(page.toLowerCase()).not.toContain(element);
    },
  );

  /**
   * Names, not just elements. A page that took a DSN from the query string or from
   * `localStorage` would pass the element check while doing the forbidden thing.
   */
  it.each([
    'password',
    'api_key',
    'apikey',
    'secret',
    'bearer',
    'connection string',
    'localstorage',
    'prompt(',
  ])('never mentions %s', (token) => {
    expect(page.toLowerCase()).not.toContain(token);
  });

  it('names a DSN only when saying it never accepts one', () => {
    // `dsn` may legitimately appear in the header's explanation of the rule. What must not
    // appear is a field, a parameter or a storage key — covered by the checks above.
    const mentions = page.toLowerCase().split('dsn').length - 1;
    expect(mentions).toBeLessThanOrEqual(1);
  });
});

describe('the page cannot be deployed pointing at a stale stack', () => {
  /**
   * `scripts/deploy-site.mts` injects `window.CORTEX_API_URL` and `window.CORTEX_STREAM_URL`
   * at upload time, because both are CloudFormation outputs. A hardcoded hostname would
   * survive a stack replacement and serve a page talking to something that no longer
   * exists — which presents as "the demo is broken" rather than as a deploy mistake.
   */
  it('reads both endpoints from the injected globals', () => {
    expect(page).toContain('window.CORTEX_API_URL');
    expect(page).toContain('window.CORTEX_STREAM_URL');
  });

  it.each(['execute-api', 'cloudfront.net', 'amazonaws.com'])(
    'hardcodes no %s hostname',
    (host) => {
      expect(page).not.toContain(host);
    },
  );
});

describe('the page says what it is, per `07` §4', () => {
  /**
   * §4 requires an always-visible mode line. It is rendered from `GET /demo/state`'s `mode`
   * block rather than written into the markup, so the page cannot claim a liveness the
   * backend is not reporting — but the element has to exist for that to land anywhere.
   */
  it('carries a mode line, and fills it from the backend', () => {
    expect(page).toContain('id="mode"');
    expect(page).toContain('state.mode.name');
  });

  /** `04` §5 invariant 1: no rung may present an error page. */
  it('handles an unreachable backend without an error page', () => {
    expect(page).toContain('backend unreachable');
    expect(page.toLowerCase()).not.toContain('stack trace');
  });
});

describe('the fleet redesign makes the coordination visible — U25', () => {
  /**
   * Break caught: replacing the page with a generic hero or removing one of the comparison
   * surfaces. The two arms, the task journey, the event graph and the produced applications are
   * the four different views a cold reader needs to connect cause to effect.
   */
  it.each([
    'id="comparison"',
    'id="journey"',
    'id="flow-graphs"',
    'id="task-board"',
    'id="results"',
    'id="benchmark"',
    'id="production"',
  ])('keeps the %s section in the single-page argument', (landmark) => {
    expect(page).toContain(landmark);
  });

  /** Break caught: a page that runs the old four-beat branch instead of the real fleet. */
  it('starts the asynchronous two-arm fleet from the one primary action', () => {
    expect(page.match(/id="run-demo"/g)).toHaveLength(1);
    expect(page).toContain("mode: 'fleet'");
    expect(page).toContain('naive: session.scopes.naive');
    expect(page).toContain("message.type === 'fleet'");
    expect(page).toContain("message.type === 'run'");
  });

  /**
   * Break caught: turning runner activity into a fake database row, or dropping committed rows
   * from the visual explanation. Design §5.3 says the two sources have different authority.
   */
  it('labels committed rows separately from timestamped fleet activity', () => {
    expect(page).toContain("message.type === 'change'");
    expect(page).toContain('COMMITTED ROW');
    expect(page).toContain('FLEET EVENT');
  });

  /**
   * Break caught: rendering the prewritten screenshots instead of the two file trees the agents
   * actually produced. Exactly two sandboxed frames make the result comparable without a toggle.
   */
  it('runs both produced applications in networkless sandboxed frames', () => {
    expect(page.match(/<iframe\b/g)).toHaveLength(2);
    expect(page.match(/sandbox="allow-scripts"/g)).toHaveLength(2);
    expect(page).toContain("cortexFrame.srcdoc = assembleApp(cortexState.files)");
    expect(page).toContain("naiveFrame.srcdoc = assembleApp(naiveState.files)");
  });

  /**
   * Break caught: always accusing the isolated arm of the designed four defects even when the
   * database produced a different race winner. The result labels must be derived from that arm's
   * returned tree, for the same reason the meter is derived from readback.
   */
  it('derives every result verdict from the returned file trees', () => {
    expect(page).toContain('const shippingWrong =');
    expect(page).toContain('const duplicateConfirmation =');
    expect(page).toContain('const oversellWrong =');
    expect(page).toContain('const missingSharedFile =');
  });

  /**
   * Break caught: treating an absent beat as a broken UI, inventing a zero, or losing the failed
   * run after some real events already arrived.
   */
  it('has deliberate states for an unobserved beat, unmeasured value and partial failure', () => {
    expect(page).toContain('NOT OBSERVED THIS RUN');
    expect(page).toContain('TBD');
    expect(page).toContain('Everything above this line happened before the run stopped.');
  });

  /**
   * Break caught: showing N/A before a run, or showing claim latency as unmeasured when that arm
   * has no claim transaction. Those are different claims and a zero is different from both.
   */
  it('distinguishes measured zero, not applicable and not measured in the meter logic', () => {
    expect(page).toContain("if (!hasRun) return { value: 'TBD'");
    expect(page).toContain("if (value === null && key === 'wastedTokens')");
    expect(page).toContain("if (value === null) return { value: 'N/A'");
    expect(page).toContain("Number(value) === 0 ? 'metric-zero'");
  });

  /**
   * Break caught: shipping a static mockup that cannot demonstrate itself when opened directly.
   * The fixture path is visibly labelled and cannot be mistaken for the deployed live database.
   */
  it('provides a clearly labelled local preview without weakening the deployed live path', () => {
    expect(page).toContain('SIMULATED UI PREVIEW');
    expect(page).toContain('runPreview');
    expect(page).toContain('backend unreachable');
  });
});

describe('the fleet redesign is self-contained and accessible', () => {
  /** Break caught: an asset or dependency that a strict deployment policy refuses to load. */
  it('makes no external asset request and draws the supplied brain mark inline', () => {
    expect(page).toContain('<svg');
    expect(page).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(page).not.toMatch(/<link[^>]+\bhref=/i);
    expect(page).not.toMatch(/<img[^>]+\bsrc=/i);
  });

  /** Break caught: motion becoming content, or running for a visitor who reduced it. */
  it('uses observer-driven reveals and collapses them under reduced motion', () => {
    expect(page).toContain('IntersectionObserver');
    expect(page).toContain('prefers-reduced-motion: reduce');
    expect(page).toContain('scroll-behavior: auto');
  });

  /** Break caught: the supplied design palette drifting into a generic blue or purple theme. */
  it.each(['#131820', '#1A2029', '#252C36', '#E8EAED', '#98A0AC', '#5CBCAA']) (
    'keeps the brand token %s',
    (token) => {
      expect(page).toContain(token);
    },
  );
});
