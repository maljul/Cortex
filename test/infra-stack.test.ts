/**
 * The deployed stack's LIVE surface, held against the code that has to run on it.
 *
 * `test/infra-config.test.ts` already pins the stack's Bedrock *embedding* configuration to
 * `.env`. This file is the same technique — read `infra/cdk/lib/cortex-stack.ts` as text and
 * hold it against a source of truth, rather than importing it, because `infra/cdk/` is a
 * separate deployable with its own module resolution and is excluded from this project's
 * `tsconfig.json`. It is a separate file rather than more cases in that one because what it
 * checks is a different thing: not "does the deployment embed with the same model", but "can
 * the deployment do the LIVE thing at all, and can it be stopped without taking the demo down".
 *
 * **Why the checks below are the ones worth having.** Every one of them stands for a failure
 * that is invisible until a judge is watching:
 *
 * - A grant on a cross-region inference profile that names only the profile fails at run time
 *   with `AccessDeniedException`, in a region nobody named, and reads exactly like a missing
 *   Bedrock entitlement. That misdiagnosis is an hour, every time.
 * - A LIVE brake that removes more than reasoning is a **rules violation**, not a bug: `04` §5
 *   says so in as many words, because B4 requires this project to stay available, free and
 *   unrestricted, until 2026-09-15.
 * - A secret that reaches the synthesized template is the finding (V22) that put every DSN
 *   behind a `{{resolve:secretsmanager:...}}` dynamic reference in the first place.
 *
 * **The template is not read here, deliberately.** `infra/cdk/cdk.out/` is gitignored, so a
 * test that asserted against it would pass vacuously on a fresh clone and fail spuriously on a
 * stale one. The source is where the leak would be introduced, and the source is what a review
 * reads, so the source is what this checks: the stack takes no value from `process.env`, and
 * every secret-bearing environment variable is bound to a `SecretValue`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stackSource = readFileSync(
  fileURLToPath(new URL('../infra/cdk/lib/cortex-stack.ts', import.meta.url)),
  'utf8',
);

const authorSource = readFileSync(
  fileURLToPath(new URL('../src/demo/author.ts', import.meta.url)),
  'utf8',
);

function literal(name: string): string | undefined {
  return new RegExp(`const ${name} = '([^']+)'`).exec(stackSource)?.[1];
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The text of one construct's property object, from its opening line to the four-space `});`
 * that closes it. Crude on purpose: a real parse would be a dependency, and the thing being
 * asserted is a property of the text a reviewer sees.
 */
function constructBlock(opening: string): string {
  const start = stackSource.indexOf(opening);
  expect(start, `${opening} is not in the stack`).toBeGreaterThan(-1);
  const end = stackSource.indexOf('\n    });', start);
  expect(end, `${opening} is not closed where this expected`).toBeGreaterThan(start);
  return stackSource.slice(start, end);
}

describe('the runner is sized for a run that waits on a model', () => {
  /**
   * 900s is Lambda's hard maximum. The value it replaced, 180s, was sized for a run that makes
   * no model call at all and takes 6–9s in region (V51); a LIVE run is a different shape and
   * the stack's own comment carries the arithmetic. Asserted as a number rather than reasoned
   * about because the failure it prevents — a run cut off mid-flight in front of a judge — is
   * indistinguishable from a crash on the page.
   */
  it('gives the runner the maximum timeout Lambda allows', () => {
    expect(constructBlock("new lambda.Function(this, 'RunnerFn'")).toMatch(
      /timeout: cdk\.Duration\.seconds\(900\)/,
    );
  });

  /** The visitor-facing route still answers fast. Raising the runner must not have moved it. */
  it('leaves the request-path function on its own, much shorter timeout', () => {
    expect(constructBlock("new lambda.Function(this, 'DemoFn'")).toMatch(
      /timeout: cdk\.Duration\.seconds\(60\)/,
    );
  });
});

describe('the reasoning grant matches the model the fleet actually calls', () => {
  /**
   * The pin. `src/demo/author.ts` decides which model a LIVE agent calls; the stack decides
   * which model the runner's role may call. Drift between them is an `AccessDeniedException`
   * at run time that looks like an entitlement problem, so it is checked rather than trusted.
   */
  it('pins the stack to src/demo/author.ts FLEET_REASON_MODEL', () => {
    const expected = /export const FLEET_REASON_MODEL = '([^']+)'/.exec(authorSource)?.[1];
    expect(expected, 'src/demo/author.ts does not export FLEET_REASON_MODEL').toBeTruthy();
    expect(literal('fleetReasonModel')).toBe(expected);
  });

  it('writes that model id exactly once, so there is no second literal to drift', () => {
    const model = literal('fleetReasonModel');
    expect(model).toBeTruthy();
    expect(occurrences(stackSource, model as string)).toBe(1);
  });

  /**
   * **Both ARN kinds, or the call fails.** A `us.` profile is an account resource that routes
   * to AWS-owned foundation models in three regions; a grant naming only the profile is denied
   * on the underlying model. Verified against this account on 2026-08-16 by reading the profile
   * itself — `aws bedrock get-inference-profile` returns exactly three `modelArn`s.
   */
  it('grants the inference profile and the foundation model behind it', () => {
    const grant = stackSource.slice(
      stackSource.indexOf('function inferenceProfileGrant('),
      stackSource.indexOf('export class CortexStack'),
    );
    expect(grant).toContain(':${account}:inference-profile/${profileId}');
    expect(grant).toContain('::foundation-model/${foundationModel}');
    // The foundation-model id is the profile id without its routing prefix, derived rather
    // than written out a second time.
    expect(grant).toMatch(/profileId\.replace\(/);
  });

  it('names every region the profile routes to, not just the one it is called from', () => {
    const regions = /const reasonRoutedRegions = \[([^\]]+)\]/.exec(stackSource)?.[1];
    expect(regions, 'the routed-region list is gone').toBeTruthy();
    for (const region of ['us-east-1', 'us-east-2', 'us-west-2']) {
      expect(regions).toContain(region);
    }
  });

  /**
   * One grant, one role. Two occurrences is the function's own definition plus a single call
   * site; a third would mean some other function had been handed the ability to author code.
   */
  it('grants reasoning exactly once, and only to the runner', () => {
    expect(occurrences(stackSource, 'inferenceProfileGrant(')).toBe(2);
    expect(stackSource).toMatch(
      /new iam\.ManagedPolicy\([\s\S]*?inferenceProfileGrant\(this\.account, fleetReasonModel\)/,
    );
    expect(stackSource).toMatch(/new iam\.ManagedPolicy\([\s\S]*?roles: \[runnerRole\]/);
  });
});

describe('the LIVE brake stops reasoning and nothing else', () => {
  const gate = (() => {
    const start = stackSource.indexOf('if (liveReasoningEnabled) {');
    expect(start, 'the LIVE brake is not gated at all').toBeGreaterThan(-1);
    return stackSource.slice(start, stackSource.indexOf('\n    }\n', start));
  })();

  /**
   * `04` §5: the brake "MUST target the LIVE reasoning function and nothing else", and one
   * wired to disable the API, the SPA, the read path or the cluster is a rules violation under
   * B4. So whatever the flag removes has to be *only* the reasoning policy — nothing that
   * serves a page, answers a route or reaches the cluster may be inside the same gate.
   */
  it('gates only the reasoning policy, never a function, a route or the site', () => {
    expect(gate).toContain('new iam.ManagedPolicy');
    for (const forbidden of [
      'new lambda.Function',
      'addRoutes',
      'new s3.Bucket',
      'new cloudfront.Distribution',
      'CORTEX_DEMO_DSN',
      'demoFn',
      'changefeedFn',
      'connectionsFn',
      'identityFn',
    ]) {
      expect(gate, `${forbidden} is inside the LIVE brake's gate`).not.toContain(forbidden);
    }
  });

  /** Absent context is LIVE-capable: the brake is something an operator fires, not a default. */
  it('leaves LIVE reasoning on unless the flag says otherwise', () => {
    expect(stackSource).toMatch(/tryGetContext\('liveReasoning'\) \?\? 'true'\)? !== 'false'/);
  });

  /**
   * The embedding grant must survive the brake. Dedupe, recall and consolidation all embed and
   * none of them is LIVE-only, so the two grants live in different policies — the reasoning one
   * in a managed policy that can be detached, the embedding one inline on the runner's role.
   */
  it('keeps the runner able to embed after the reasoning policy is detached', () => {
    expect(stackSource).toMatch(
      /runnerFn\.addToRolePolicy\([\s\S]{0,400}?foundation-model\/\$\{embedModel\}/,
    );
    const managed = stackSource.slice(stackSource.indexOf('new iam.ManagedPolicy('));
    expect(managed.slice(0, managed.indexOf('\n      });'))).not.toContain('embedModel');
  });

  /** An operator needs both halves of the detach command without opening this file. */
  it('publishes the policy and the role it attaches to as stack outputs', () => {
    expect(stackSource).toMatch(/new cdk\.CfnOutput\(this, 'LiveReasoningPolicyArn'/);
    expect(stackSource).toMatch(/new cdk\.CfnOutput\(this, 'RunnerRoleName'/);
  });
});

describe('the LIVE capability token is a dynamic reference and never a value', () => {
  /** Every identifier in the stack that holds a secret, with the secret it resolves. */
  const secretBound = new Map(
    [
      ...stackSource.matchAll(
        /const (\w+) = cdk\.SecretValue\.secretsManager\('([^']+)'\)\.unsafeUnwrap\(\);/g,
      ),
    ].map((match) => [match[1] as string, match[2] as string]),
  );

  it('binds the token to a Secrets Manager secret under the deployment namespace', () => {
    expect([...secretBound.values()]).toContain('cortex/live-token');
  });

  /**
   * Design §7.1 names three homes the expected value must never have, and one of them is this
   * file. Whatever `LIVE_TOKEN` is set from must be one of the secret-bound identifiers above —
   * not a literal, not a synth-time read, not a value injected by a deploy script.
   */
  it('sets LIVE_TOKEN from that secret on every function that carries it', () => {
    const assignments = [...stackSource.matchAll(/LIVE_TOKEN: (\w+),/g)].map((m) => m[1] as string);
    expect(assignments.length, 'no function carries LIVE_TOKEN').toBeGreaterThan(0);
    for (const identifier of assignments) {
      expect(secretBound.get(identifier), `LIVE_TOKEN is set from ${identifier}`).toBe(
        'cortex/live-token',
      );
    }
  });

  it('carries it on the route that compares it and on the function that spends the money', () => {
    expect(constructBlock("new lambda.Function(this, 'DemoFn'")).toContain('LIVE_TOKEN:');
    expect(constructBlock("new lambda.Function(this, 'RunnerFn'")).toContain('LIVE_TOKEN:');
  });

  /**
   * The V22 finding, generalised. A stack that reads its environment at synth time puts the
   * value it read into the template — that is not a risk, it is what was measured happening.
   * No property access on `process.env` may exist here at all; the word appears once, in the
   * comment that records why.
   */
  it('reads nothing from the synthesizing shell', () => {
    expect(stackSource).not.toMatch(/process\.env\s*[.[]/);
  });

  it('leaves the DSN and the changefeed token bound the same way', () => {
    expect([...secretBound.values()]).toContain('cortex/demo-dsn');
    expect([...secretBound.values()]).toContain('cortex/changefeed-token');
  });
});
