/**
 * THE DEGRADATION LADDER AND THE LIVE CAPABILITY — spec/04-ARCHITECTURE.md §5, design §7.
 *
 * `npm run gate:ladder` forces each rung against the real cluster and is what decides U17's
 * done-when. This file holds the parts of the same contract that a test can hold better than a
 * gate can: the shape of the capability comparison, the arithmetic behind the cap, and the
 * refusals that must not drift.
 *
 * Three invariants are reachable from here:
 *
 * - **7 — no agent-reachable path accepts a structural parameter.** A URL parameter is the most
 *   agent-reachable path there is, and design §7.1 puts the LIVE capability on one. It is
 *   compared, never interpolated, and the comparison is constant-time.
 * - **8 — no credential field on any demo surface.** The capability is not a credential field:
 *   it is not named for one, it is never echoed, and it never reaches an input element. The
 *   assertions below are about the first two; `test/site.test.ts` owns the third.
 * - **1 (of `04` §5) — no rung may present an error page.** Every limit resolves to a value.
 *
 * **Nothing here writes a token, a DSN or any other credential-shaped literal.** The capability
 * cases generate their own secret and assert on lengths and outcomes; the one connection-string
 * literal is the fixture `scripts/gate-mechanical.sh` already blesses and
 * `test/demo-plane.test.ts` already uses, reused rather than varied for exactly that reason.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { backendUnreachable, findCredentialField } from '../src/demo/api.js';
import {
  authoriseLiveRun,
  liveCapabilityGranted,
  liveRunCostUsd,
  LIVE_BUDGET_USD,
  LIVE_BUDGET_WINDOW_DAYS,
  LIVE_RUNS_PER_DAY,
  LIVE_UNBRAKED_WINDOW_USD,
  MEASURED_REASON_RATE_USD_PER_MTOK,
  METERED_LIVE_RUN,
  PUBLIC_REPLAY_REASON,
} from '../src/memory/live-budget.js';

const original = process.env['LIVE_TOKEN'];

afterEach(() => {
  if (original === undefined) delete process.env['LIVE_TOKEN'];
  else process.env['LIVE_TOKEN'] = original;
});

/** A capability for this test only. Never written down; only its length is ever asserted. */
function ephemeral(): string {
  return randomBytes(32).toString('base64url');
}

describe('the capability link — design §7.1, invariant 7', () => {
  it('grants only on an exact match', () => {
    const token = ephemeral();
    process.env['LIVE_TOKEN'] = token;

    expect(liveCapabilityGranted(token)).toBe(true);
  });

  it('refuses a different secret of the same length without throwing', () => {
    const token = ephemeral();
    const other = ephemeral();
    process.env['LIVE_TOKEN'] = token;

    // Same alphabet, same length, different bytes — the case `timingSafeEqual` is for.
    expect(other.length).toBe(token.length);
    expect(liveCapabilityGranted(other)).toBe(false);
  });

  it('refuses a secret of a different length rather than throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, so the guard in front of it is required
    // rather than an optimisation. Without it, a one-character `?live=` takes the route down —
    // which `04` §5 invariant 1 forbids on the most reachable path this surface has.
    process.env['LIVE_TOKEN'] = ephemeral();

    for (const presented of ['x', '', randomBytes(64).toString('base64url')]) {
      expect(() => liveCapabilityGranted(presented)).not.toThrow();
      expect(liveCapabilityGranted(presented)).toBe(false);
    }
  });

  it('is unavailable rather than broken when no secret is configured', () => {
    // "If it is unset, LIVE is simply unavailable and REPLAY is served — never a 500."
    delete process.env['LIVE_TOKEN'];

    expect(liveCapabilityGranted(ephemeral())).toBe(false);
    expect(liveCapabilityGranted(undefined)).toBe(false);
  });

  it('refuses an empty configured secret, so a blank variable cannot open the gate', () => {
    process.env['LIVE_TOKEN'] = '';

    // An empty string is falsy and a Buffer of it is zero length, so a naive comparison would
    // grant every caller who also sent nothing. Both halves are refused.
    expect(liveCapabilityGranted('')).toBe(false);
    expect(liveCapabilityGranted(ephemeral())).toBe(false);
  });
});

describe('the capability parameter is not a credential field — invariant 8', () => {
  it('is named something the credential scan does not refuse', () => {
    // Design §7.1 fixes the parameter as `live`. If that name were credential-shaped, the
    // refusal that protects this surface would reject the capability it is meant to carry, and
    // LIVE would be dead on the deployed API with nothing failing anywhere.
    expect(findCredentialField({ live: ephemeral() }, ['query'])).toBeNull();
  });

  it('still refuses a connection string pasted into it', () => {
    // The value scan applies to `live` like every other query value. A visitor who pastes a DSN
    // into the capability parameter is the same failure V45 closed, and gets the same refusal —
    // the parameter is not exempt just because the route reads it.
    expect(findCredentialField({ live: 'postgresql://user:pw@host/db' }, ['query'])).toBe(
      'query.live',
    );
  });
});

describe('the cap is derived from a metered run, not written — U24', () => {
  it('has a metered run to derive from at all', () => {
    // The done-when is "one metered LIVE run exists and the cap is derived from it, not
    // estimated". `null` here is design §7.3's own instruction for the state before that run:
    // the config carries TBD and LIVE stays disabled. This asserts the run happened.
    expect(METERED_LIVE_RUN).not.toBeNull();
    expect(METERED_LIVE_RUN!.calls).toBeGreaterThan(0);
    expect(METERED_LIVE_RUN!.inputTokens).toBeGreaterThan(0);
    expect(METERED_LIVE_RUN!.outputTokens).toBeGreaterThan(0);
  });

  it('is design §7.3’s formula and not a number somebody chose', () => {
    // Recomputed from the same inputs rather than compared to a literal. A literal here would
    // pass for ever after somebody edited the constant to a value the measurement does not
    // support, which is the exact failure `LIVE_RUNS_PER_DAY = 10` was carrying until now.
    const cost = liveRunCostUsd(METERED_LIVE_RUN!);
    expect(LIVE_RUNS_PER_DAY).toBe(Math.floor(LIVE_BUDGET_USD / cost));
  });

  it('lets one maxed day spend at most the whole budget and no more', () => {
    // The daily cap's meaning in one assertion. `04` §5 gives brake 2 a rate and brake 3 the
    // monetary bound; this is the rate expressed at the only monetary limit it can carry.
    const cost = liveRunCostUsd(METERED_LIVE_RUN!);
    expect(LIVE_RUNS_PER_DAY * cost).toBeLessThanOrEqual(LIVE_BUDGET_USD);
    // Non-vacuous: one more run would break it, so the cap is the largest that fits.
    expect((LIVE_RUNS_PER_DAY + 1) * cost).toBeGreaterThan(LIVE_BUDGET_USD);
  });

  it('publishes what brake 3 has to stop, because brake 3 is not built', () => {
    // A specification for a brake that does not say what it is stopping is one nobody can
    // check. This is the exposure a full window of maxed days carries with no cumulative bound.
    const cost = liveRunCostUsd(METERED_LIVE_RUN!);
    expect(LIVE_UNBRAKED_WINDOW_USD).toBeCloseTo(
      LIVE_RUNS_PER_DAY * LIVE_BUDGET_WINDOW_DAYS * cost,
      6,
    );
    expect(LIVE_UNBRAKED_WINDOW_USD).toBeGreaterThan(LIVE_BUDGET_USD);
  });

  it('prices both token directions, and output dearer than input', () => {
    // Guards the arithmetic against a transposed rate, which would understate the expensive
    // half of the bill by a factor of five and inflate the cap by the same.
    const cost = liveRunCostUsd({ at: '', calls: 1, inputTokens: 1_000_000, outputTokens: 0 });
    const output = liveRunCostUsd({ at: '', calls: 1, inputTokens: 0, outputTokens: 1_000_000 });

    expect(cost).toBeCloseTo(MEASURED_REASON_RATE_USD_PER_MTOK.input, 10);
    expect(output).toBeCloseTo(MEASURED_REASON_RATE_USD_PER_MTOK.output, 10);
    expect(output).toBeGreaterThan(cost);
  });
});

describe('rung 1 — exhaustion is a value, never an exception', () => {
  it('refuses a cap of zero without spending anything, and says why', async () => {
    // Reachable rather than theoretical: the cap is derived, and it is zero whenever no metered
    // run exists. `LIVE_BUDGET_CLAIM_SQL`'s `WHERE` guards only the conflict branch, so on the
    // first call of a day the INSERT would land `runs_used = 1` and grant a run the budget does
    // not afford. The guard in front of the statement is what this holds up.
    const authorisation = await authoriseLiveRun({ cap: 0 });

    expect(authorisation.mode).toBe('replay');
    expect(authorisation.used).toBe(0);
    expect(authorisation.remaining).toBe(0);
    // §5's ladder row for rung 1 ends "database behaviour fully live". Both halves, every time.
    expect(authorisation.reason).toMatch(/(database|CockroachDB)/i);
    expect(authorisation.reason).toMatch(/live/i);
  });

  it('says nothing about a gate in the sentence an anonymous visitor sees', () => {
    // Design §7.1: without a token "the page renders exactly as the public page does — no
    // error, no hint that a gate exists". A REPLAY notice naming a quota is that hint.
    expect(PUBLIC_REPLAY_REASON).not.toMatch(/quota|budget|token|capability|remain|live run/i);
    // And it still has to be honest about what is replayed and what is not.
    expect(PUBLIC_REPLAY_REASON).toMatch(/replay/i);
    expect(PUBLIC_REPLAY_REASON).toMatch(/(database|CockroachDB)/i);
  });
});

describe('rung 4 — the page is told it is not live', () => {
  it('names the rung and refuses to imply liveness', () => {
    const response = backendUnreachable(new Error('connect ECONNREFUSED'));
    const body = JSON.parse(response.body) as Record<string, unknown>;

    expect(response.statusCode).toBe(503);
    expect(body['rung']).toBe(4);
    expect(body['live']).toBe(false);
    // `04` §5 invariant 2 and rule A7: "A static fallback that silently depicts a live system
    // would breach rule A7 far more seriously than replayed reasoning does."
    expect(String(body['banner'])).toMatch(/pre-recorded/i);
    expect(String(body['banner'])).toMatch(/not live|nothing on this page is live/i);
  });

  it('does not echo the driver’s message, which can carry the host it failed to reach', () => {
    const response = backendUnreachable(
      Object.assign(new Error('getaddrinfo ENOTFOUND cluster.example.invalid'), {
        code: 'ENOTFOUND',
      }),
    );

    expect(response.body).toContain('ENOTFOUND');
    expect(response.body).not.toContain('cluster.example.invalid');
    expect(response.body).not.toContain('getaddrinfo');
  });
});
