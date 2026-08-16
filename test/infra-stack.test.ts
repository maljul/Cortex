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
   * One grant, one role.
   *
   * **This counted call sites and had to stop.** It asserted `inferenceProfileGrant(` appeared
   * exactly twice — its definition plus one call — and brake 3 legitimately made that three: the
   * deny policy must name the *same* ARNs as the allow, or the brake would cover less than the
   * grant and leave a hole exactly where it matters. Counting was a proxy for the real rule, and
   * the real rule is about **Allow**: no second function may be handed the ability to author code.
   * So the assertion now separates the two policies and checks each for what it is.
   */
  it('grants reasoning exactly once, and only to the runner', () => {
    const allow = /new iam\.ManagedPolicy\(this, 'LiveReasoningPolicy'[\s\S]*?\n      \}\);/.exec(stackSource)?.[0] ?? '';
    const deny = /new iam\.ManagedPolicy\(this, 'LiveReasoningDenyPolicy'[\s\S]*?\n    \}\);/.exec(stackSource)?.[0] ?? '';

    expect(allow.length, 'the reasoning grant must exist').toBeGreaterThan(0);
    expect(deny.length, 'the brake-3 deny must exist').toBeGreaterThan(0);

    // Exactly one policy grants it, and only the runner holds that one.
    expect(allow).not.toContain('iam.Effect.DENY');
    expect(allow).toContain('inferenceProfileGrant(this.account, fleetReasonModel)');
    expect(allow).toContain('roles: [runnerRole]');

    /**
     * **The grant's verb list, which nothing checked until a mutation went unnoticed.** Widening
     * this policy to `actions: ['*']` left all 25 assertions green — the ARN scope was pinned and
     * the verb was not, so the runner's role could have been handed every Bedrock action on those
     * resources with the suite passing. The scope of a grant is both halves.
     */
    expect(allow).toContain("actions: ['bedrock:InvokeModel']");
    expect(allow).not.toContain("'*'");

    // Three call sites and no more: the definition, the allow, the deny. A fourth would mean some
    // other function had been handed the ability to author code.
    expect(occurrences(stackSource, 'inferenceProfileGrant(')).toBe(3);

    // The deny must cover exactly what the allow covers — same expression, not a re-typed list.
    expect(deny).toContain('inferenceProfileGrant(this.account, fleetReasonModel)');
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

/**
 * BRAKE 3 — `04` §5's automatic cost brake.
 *
 * Until 2026-08-16 stopping LIVE was a human noticing, and U24 measured what that was worth:
 * at $0.2910 a metered run and a cap of 30 a day, thirty-one unbraked days is $270.58 against
 * a $9 budget. These assertions are about the two ways a Budget silently does nothing — the
 * wrong filter and the wrong period — and about the one way it does too much.
 */
describe('brake 3 bounds the LIVE budget automatically', () => {
  it('fires at the same number the runner budgets against', () => {
    // The stack cannot import from src/ — `cdk synth` runs under its own tsconfig — so the two
    // constants are separate literals and this is what holds them together. A brake that fires
    // at a different figure from the one `live-budget.ts` plans against is a brake nobody can
    // reason about.
    const budgetSource = readFileSync(
      fileURLToPath(new URL('../src/memory/live-budget.ts', import.meta.url)),
      'utf8',
    );
    const runtime = /export const LIVE_BUDGET_USD = (\d+(?:\.\d+)?)/.exec(budgetSource)?.[1];
    const stack = /const liveBudgetUsd = (\d+(?:\.\d+)?)/.exec(stackSource)?.[1];

    expect(runtime, 'src/memory/live-budget.ts must declare LIVE_BUDGET_USD').toBeDefined();
    expect(stack, 'the stack must declare liveBudgetUsd').toBeDefined();
    expect(stack).toBe(runtime);
  });

  /**
   * **The filter is where a Budget fails silently, and it has already failed here once.** V36
   * measured that Anthropic model spend does not bill under `Amazon Bedrock` — that service
   * carries only the Titan embedding line — so a Budget filtered on it watches an empty meter
   * and never fires. The service names below were read from
   * `aws ce get-dimension-values --dimension SERVICE` on 2026-08-16 rather than guessed.
   */
  it('watches the services the reasoning spend actually lands on', () => {
    expect(stackSource).toContain('Claude Haiku 4.5 (Amazon Bedrock Edition)');
    expect(stackSource).toContain('Claude Sonnet 4.5 (Amazon Bedrock Edition)');
  });

  it('never filters on Amazon Bedrock, which would watch only the Titan line', () => {
    const filterBlock = /costFilters:\s*\{[\s\S]*?\},/.exec(stackSource)?.[0] ?? '';
    expect(filterBlock.length, 'the cost filter must exist to be checked').toBeGreaterThan(0);
    expect(filterBlock).not.toContain("'Amazon Bedrock'");
  });

  /**
   * The judging window spans two calendar months. A MONTHLY budget at $9 permits $9 in August
   * and $9 again in September, which is $18 against a $9 promise.
   */
  it('bounds the whole event rather than each calendar month', () => {
    expect(stackSource).toContain("timeUnit: 'ANNUALLY'");
    expect(stackSource).not.toContain("timeUnit: 'MONTHLY'");
  });

  it('fires without waiting for a human to approve it', () => {
    expect(stackSource).toContain("approvalModel: 'AUTOMATIC'");
  });

  /**
   * The action denies reasoning and nothing else. `04` §5 is explicit that a budget action which
   * disables the API, the SPA, the read path or the cluster converts a cost control into a rules
   * violation, because B4 requires this project to stay available until 2026-09-15.
   */
  it('denies the fleet model and takes no other capability with it', () => {
    const deny = /new iam\.ManagedPolicy\(this, 'LiveReasoningDenyPolicy'[\s\S]*?\}\);/.exec(stackSource)?.[0] ?? '';
    expect(deny.length, 'the deny policy must exist').toBeGreaterThan(0);
    expect(deny).toContain('iam.Effect.DENY');
    expect(deny).toContain("actions: ['bedrock:InvokeModel']");
    expect(deny).toContain('inferenceProfileGrant(this.account, fleetReasonModel)');
    // Anything wider than InvokeModel on the fleet model is out of scope for a cost brake.
    expect(deny).not.toContain('lambda:');
    expect(deny).not.toContain('apigateway:');
    expect(deny).not.toContain("'*'");
  });

  it('leaves the deny attached to nobody until it fires', () => {
    const deny = /new iam\.ManagedPolicy\(this, 'LiveReasoningDenyPolicy'[\s\S]*?\}\);/.exec(stackSource)?.[0] ?? '';
    // `roles:` on the *deny* policy would disable LIVE at deploy time — the brake permanently on.
    expect(deny).not.toContain('roles:');
  });

  /**
   * The Budgets execution role can attach one policy to one role. A brake whose execution role
   * could attach anything to anything would be a larger hazard than the spend it prevents.
   */
  it('gives Budgets only the permission to apply that one policy to that one role', () => {
    const role = /new iam\.Role\(this, 'BudgetActionRole'[\s\S]*?\n    \}\);/.exec(stackSource)?.[0] ?? '';
    expect(role.length, 'the budget action role must exist').toBeGreaterThan(0);
    expect(role).toContain("iam.ServicePrincipal('budgets.amazonaws.com')");
    expect(role).toContain('resources: [runnerRole.roleArn]');
    expect(role).toContain("'iam:PolicyARN': denyReasoning.managedPolicyArn");
    expect(role).not.toContain("resources: ['*']");
  });

  /** An email in a public template is a published address. Same rule as every DSN. */
  it('takes the subscriber address as a dynamic reference, never a literal', () => {
    expect(stackSource).toContain("cdk.SecretValue.secretsManager('cortex/budget-alert-email')");
    // No address-shaped literal anywhere in the stack.
    expect(stackSource).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

/**
 * A rule about the whole stack rather than one policy, found by a mutation that missed its target.
 *
 * While mutation-testing brake 3 I replaced the *first* `actions: ['bedrock:InvokeModel']` in the
 * file — which is a Titan embedding grant, not the reasoning one — and every assertion stayed
 * green. The reasoning grant was pinned on both scope and verb; the three embedding grants were
 * pinned on neither, so any of them could have been widened to every Bedrock action on those
 * resources without a single test noticing.
 *
 * This is deliberately a statement about the file rather than about a named policy: a fourth grant
 * added later is covered without anybody remembering to cover it.
 */
describe('no policy in the stack grants a wildcard action', () => {
  it('every PolicyStatement names its verbs', () => {
    const wildcards = [...stackSource.matchAll(/actions:\s*\[([^\]]*)\]/g)]
      .map((match) => match[1]!.trim())
      .filter((verbs) => verbs.includes("'*'"));

    expect(wildcards, 'a wildcard action grant reached the stack').toEqual([]);
  });

  it('and that scan is not vacuous — it finds the verb lists that are there', () => {
    const all = [...stackSource.matchAll(/actions:\s*\[([^\]]*)\]/g)];
    // Five Bedrock grants (three embedding, one reasoning allow, one reasoning deny) plus the
    // Budgets execution role's attach/detach pair. A scan finding none would pass the test above
    // for the wrong reason.
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.some((m) => m[1]!.includes('bedrock:InvokeModel'))).toBe(true);
    expect(all.some((m) => m[1]!.includes('iam:AttachRolePolicy'))).toBe(true);
  });
});
