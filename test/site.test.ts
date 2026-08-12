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
