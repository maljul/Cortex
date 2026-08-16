/**
 * The CORTEX deployment. One CDK app in `infra/`, per `04` §2.
 *
 * This was `infra/cdk-spike/` until U14. B2 built it to burn down one risk — can a
 * Lambda reach CockroachDB Cloud at all — and the answer was yes with no VPC, no custom
 * CA and a warm query at 3ms (V22). What it deployed is still here, renamed rather than
 * rewritten, because "spike" stopped being true the moment the demo depended on it.
 *
 * Five functions, and the concurrency they share is the binding constraint on this whole
 * deployment. See `CONCURRENCY` below before adding a sixth.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import * as path from 'node:path';

const DIST = path.join(__dirname, '..', '..', 'lambda-dist');

/**
 * **THE CONCURRENCY BUDGET.** `04` §5 asks for this to be decided and written down
 * before functions are added that quietly compete for it, so here it is.
 *
 * This account's Lambda concurrency limit is **10**, not AWS's default of 1000, and V22
 * established that it cannot be raised from the CLI. What U14 measured on top of that is
 * worse, and it changes `04` §5:
 *
 *   $ aws lambda put-function-concurrency --function-name …Identity… \
 *       --reserved-concurrent-executions 2
 *   InvalidParameterValueException: Specified ReservedConcurrentExecutions for function
 *   decreases account's UnreservedConcurrentExecution below its minimum value of [10].
 *
 * **Reserved concurrency cannot be set on this account at all.** The floor for
 * unreserved concurrency is 10 and the ceiling is also 10, so every reservation from 1
 * upwards is refused. `04` §5's brake 1 — "reserved concurrency of 2 on the LIVE
 * Lambda" — is not implementable here, and no function below carries a reservation.
 * That is recorded in `docs/SPEC-DELTA.md` rather than worked around in code, because
 * the replacement brake is `04` §5's decision to re-make and U17's to force.
 *
 * So all five functions draw on one shared pool of 10, and the budget is a statement
 * about what is expected to be in flight rather than a limit any of them can exceed:
 *
 *   demo        — the visitor-facing route. Every panel refresh is one invocation.
 *   runner      — one per fleet run, held for 6–9s in REPLAY (V51). The expensive one; see
 *                 below. A LIVE run holds its slot for as long as the model takes, which is
 *                 not yet measured end to end — what bounds the number of them is the global
 *                 run counter (`04` §5 brake 2), not concurrency, of which there is none to
 *                 be had on this account.
 *   changefeed  — one at a time in practice; the sink posts batches, not rows.
 *   connections — $connect / $disconnect only, and both are sub-millisecond.
 *   identity    — a curl target for the README and the video. Effectively idle.
 *
 * **U22 added `runner`, and it is the first function here that holds a slot for seconds
 * rather than milliseconds.** Design §5.2 fixes one visitor's run at **two** invocations —
 * this route handler and that runner — precisely because of the ceiling above: ten agents
 * as ten Lambdas would consume the entire account for one visitor. With the agents as
 * async tasks *inside* the runner, five concurrent visitors is the arithmetic (two each),
 * and the sixth waits.
 *
 * **The cost is smaller than the design assumed, and it was measured (V51).** A deployed
 * run is 6–9 seconds, not the 50–70 the design inferred from laptop timings, and the route
 * handler returns in 482ms — so the two invocations barely overlap and the runner's slot is
 * held briefly. The mitigation is not concurrency, of which there is none to be had on this
 * account: it is that a run is *watched*, not polled. Everything after the 202 arrives over
 * one WebSocket, so a visitor occupies no HTTP slot at all while watching, which is what
 * keeps this arithmetic workable when U24's LIVE mode makes a run genuinely long.
 *
 * Ten simultaneous visitors can still exhaust it, and the fifth rung U17 has to build is
 * what answers when they do. Nothing here pretends otherwise.
 */
const CONCURRENCY = {
  accountLimit: 10,
  reservedPerFunction: 'unavailable on this account',
  invocationsPerFleetRun: 2,
};

/**
 * Bedrock's region and the embedding model, for consolidation (flow D).
 *
 * Written here rather than read from `.env` at synth time because neither is a
 * credential and because `cdk synth` runs from `infra/cdk/` without the repository's
 * environment loaded — a value that silently defaulted would be worse than one written
 * down. **They MUST match `.env`**, and `test/infra-config.test.ts` fails if they drift.
 *
 * The drift is not cosmetic. `src/embed/titan.ts` hashes model *and* width into its cache
 * key precisely because a sentence embedded by a different model at a different width is
 * a different vector, so a deployment consolidating with one model into findings that
 * local runs recall with another would produce distances that mean nothing.
 */
const bedrockRegion = 'us-east-1';
const embedModel = 'amazon.titan-embed-text-v2:0';

/**
 * The fleet's reasoning model — the one a LIVE agent authors its patch with, and the only
 * reasoning model any deployed function here may invoke.
 *
 * **Pinned to `src/demo/author.ts`'s `FLEET_REASON_MODEL` by `test/infra-stack.test.ts`**, and
 * that pin is the point rather than tidiness: the grant below is scoped by ARN, so an author
 * that repointed its model without this following would fail at run time with an
 * `AccessDeniedException` — which reads exactly like a missing Bedrock entitlement and sends
 * whoever is debugging it to the wrong account page.
 *
 * **It is reachable only as a cross-region inference profile.** Invoked on this account on
 * 2026-08-16: the `us.`-prefixed id below answers in ~1470ms, and the bare foundation-model id
 * is refused with `ValidationException` — invocation "with on-demand throughput isn't
 * supported". So this is a *profile* id, not a model id, and a grant on it needs two kinds of
 * ARN rather than one. `inferenceProfileGrant` is where that is spelled out.
 *
 * Not Sonnet 4.5, which `.env`'s `BEDROCK_REASON_MODEL` names and which `bench/reason.ts`
 * calls: that path runs from a laptop under a developer's credentials and never from a Lambda,
 * so granting it here would authorise something no deployed code does.
 */
const fleetReasonModel = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Where a `us.` profile actually routes. Read off the profile rather than assumed:
 *
 *   $ aws bedrock get-inference-profile --inference-profile-identifier <the profile id>
 *   "Routes requests to Anthropic Claude Haiku 4.5 in us-east-1, us-east-2 and us-west-2."
 *
 * The three `modelArn`s it returns are the three below. A grant that names only the region the
 * caller is in is the failure this list exists to prevent: Bedrock routes the request to a
 * region the caller never named, and the denial arrives from there.
 */
const reasonRoutedRegions = ['us-east-1', 'us-east-2', 'us-west-2'];

/**
 * The ARNs one cross-region inference profile needs, which is **both kinds and not either**.
 *
 * - the inference profile, which is an *account* resource and so carries an account id;
 * - the foundation model behind it, in every region the profile routes to, which is an
 *   AWS-owned resource and so carries an empty account field.
 *
 * The profile id carries a routing prefix the foundation model does not — `us.anthropic.…` is
 * the profile, `anthropic.…` is the model it routes to — so the second set is derived by
 * stripping it rather than by writing the id out twice, where the two could drift.
 */
function inferenceProfileGrant(account: string, profileId: string): string[] {
  const foundationModel = profileId.replace(/^[a-z]{2}\./, '');
  return [
    `arn:aws:bedrock:${bedrockRegion}:${account}:inference-profile/${profileId}`,
    ...reasonRoutedRegions.map(
      (region) => `arn:aws:bedrock:${region}::foundation-model/${foundationModel}`,
    ),
  ];
}

export class CortexStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The DSNs are CloudFormation **dynamic references**, not values. `secretsManager()`
    // synthesizes `{{resolve:secretsmanager:...}}`, which CloudFormation resolves at
    // deploy time, so the secret never enters the template, `cdk.out/`, or the
    // CloudFormation API's stored copy of either.
    //
    // This replaced reading the DSN from `process.env` at synth time, which was measured
    // doing exactly what it looked like it did: `grep sslmode` against the synthesized
    // template matched. That is V22's finding, and it is why the arrangement is named
    // here rather than quietly tidied away.
    //
    // `unsafeUnwrap` is the correct call despite its name: it is unsafe precisely because
    // it puts the token into the template, and the token is what we want there. The
    // secrets are created out of band (`aws secretsmanager create-secret`) so their
    // values pass from the shell to Secrets Manager without touching this repository.
    const demoDsn = cdk.SecretValue.secretsManager('cortex/demo-dsn').unsafeUnwrap();
    const changefeedToken = cdk.SecretValue.secretsManager('cortex/changefeed-token').unsafeUnwrap();

    // The LIVE capability token — design §7.1's `/?live=<token>`, the thing that distinguishes a
    // judge who was sent the link from an anonymous visitor. It is here under exactly the same
    // arrangement as the two above, and for a stronger reason: §7.1 names three homes it must
    // never have, and one of them is this file. It is never a literal in `infra/`, never injected
    // into `infra/site/index.html` by `scripts/deploy-site.mts`, and never a template value —
    // the first DSN arrangement leaked one into `cdk.out/` and that is the whole reason the
    // dynamic-reference rule exists. A demo access token is the same class of thing.
    //
    // Created out of band like the other two. A deploy against a secret that was never created
    // fails at CloudFormation with an unresolvable-reference error, which is the message that
    // means "the secret is missing", not "the stack is wrong" — and the tempting fix in that
    // moment is to paste the value here, which is what this comment exists to refuse.
    const liveToken = cdk.SecretValue.secretsManager('cortex/live-token').unsafeUnwrap();

    // Connection ids for the live view, and nothing else. Deployment bookkeeping with a
    // lifetime of minutes — deliberately not a seventh table in `03` §2's memory model.
    const connections = new dynamodb.TableV2(this, 'Connections', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const runtime = {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      // 15s rather than the default 3: `src/db/pool.ts` gives up on connecting at 10s,
      // so a timeout here means the handler never returned, not that the cluster was
      // slow to answer.
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
    };

    // Runs as `cortex_demo`, the least-privileged principal there is here, because a
    // route anyone on the internet can curl has no business holding more. It answers with
    // the cluster's own build string, which is the shortest demonstration that the hosted
    // surface talks to a real CockroachDB cluster.
    const identityFn = new lambda.Function(this, 'IdentityFn', {
      ...runtime,
      code: lambda.Code.fromAsset(path.join(DIST, 'identity')),
      environment: { CORTEX_DEMO_DSN: demoDsn },
    });

    // The show-SQL transcript. Separate from `Connections` because the two have different
    // keys and different lifetimes, and a single table keyed on a union of the two would
    // be cleverness with no payoff at this size.
    const sqlLog = new dynamodb.TableV2(this, 'SqlLog', {
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const demoFn = new lambda.Function(this, 'DemoFn', {
      ...runtime,
      // 60s: `POST /demo/run` performs the four beats against the cluster — several
      // embeddings and half a dozen transactions. It is the one visitor-facing route that
      // does real work, and a timeout here would show a judge an error rather than a beat.
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromAsset(path.join(DIST, 'demo')),
      environment: {
        CORTEX_DEMO_DSN: demoDsn,
        SQL_LOG_TABLE: sqlLog.tableName,
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_EMBED_MODEL: embedModel,
        // The route handler is where `?live=<token>` arrives, so it is where the comparison
        // belongs. §7.1: compared server-side, constant-time, and **compared rather than
        // interpolated** — a URL parameter is the most agent-reachable path there is
        // (invariant 7), and the page carries no field for it (invariant 8).
        LIVE_TOKEN: liveToken,
      },
    });
    sqlLog.grantReadWriteData(demoFn);
    demoFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}::foundation-model/${embedModel}`,
          `arn:aws:bedrock:${bedrockRegion}:${this.account}:inference-profile/${embedModel}`,
        ],
      }),
    );

    const connectionsFn = new lambda.Function(this, 'ConnectionsFn', {
      ...runtime,
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      code: lambda.Code.fromAsset(path.join(DIST, 'connections')),
      environment: { CONNECTIONS_TABLE: connections.tableName },
    });
    connections.grantWriteData(connectionsFn);

    const webSocketApi = new apigw.WebSocketApi(this, 'StreamApi', {
      connectRouteOptions: {
        integration: new apigwIntegrations.WebSocketLambdaIntegration('Connect', connectionsFn),
      },
      disconnectRouteOptions: {
        integration: new apigwIntegrations.WebSocketLambdaIntegration('Disconnect', connectionsFn),
      },
    });

    const streamStage = new apigw.WebSocketStage(this, 'StreamStage', {
      webSocketApi,
      stageName: 'live',
      autoDeploy: true,
    });

    const changefeedFn = new lambda.Function(this, 'ChangefeedFn', {
      ...runtime,
      code: lambda.Code.fromAsset(path.join(DIST, 'changefeed')),
      // 30s rather than 15: this function embeds via Bedrock on a closed intent (flow D),
      // and a cold Titan call plus a cold pool is the one path here that can legitimately
      // take a while. It is off the critical path, so waiting costs no agent anything.
      timeout: cdk.Duration.seconds(30),
      environment: {
        CORTEX_DEMO_DSN: demoDsn,
        CONNECTIONS_TABLE: connections.tableName,
        WEBSOCKET_CALLBACK_URL: streamStage.callbackUrl,
        CHANGEFEED_TOKEN: changefeedToken,
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_EMBED_MODEL: embedModel,
      },
    });

    // Consolidation embeds the outcome it is about to store. Scoped to the one model
    // `05` §6 names: this function has no business invoking a reasoning model, and the
    // LIVE reasoning path is a different function with a different brake on it.
    changefeedFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}::foundation-model/${embedModel}`,
          `arn:aws:bedrock:${bedrockRegion}:${this.account}:inference-profile/${embedModel}`,
        ],
      }),
    );
    connections.grantReadWriteData(changefeedFn);
    // Scoped to this stage rather than `*`: the fan-out posts to sockets on the live
    // stage and has no business managing any other API's connections.
    changefeedFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          this.formatArn({
            service: 'execute-api',
            resource: webSocketApi.apiId,
            resourceName: `${streamStage.stageName}/POST/@connections/*`,
          }),
        ],
      }),
    );

    /**
     * U22'S RUNNER — one visitor's fleet run, off the request path.
     *
     * **Not because the run would blow the gateway ceiling.** V51 measured that it does not:
     * both arms complete in 5.9–8.3s in-region against a 30,000ms integration timeout, and a
     * synchronous invocation answered in 4548ms. The shape is kept because the stream is the
     * demo and because U24's LIVE mode will exceed the ceiling; the argument lives in
     * `src/demo/run.ts`'s header, next to the code it governs.
     *
     * **900s, which is Lambda's hard maximum, and the arithmetic is why.**
     *
     * The 180s this replaced was sized for a run that makes no model call at all: both arms
     * against the cluster and nothing else, measured at 6–9s in region (V51). That is the REPLAY
     * run, it still takes 6–9s, and 180s was roughly 20× its longest measurement.
     *
     * LIVE is a different shape. The budget it is sized against, as a target rather than a
     * measurement — no LIVE fleet run has been timed end to end at the time of writing:
     *
     *   ~60s of model time per worked ticket
     *   × eleven tickets spread across five agents that run concurrently within an arm
     *     ≈ three tickets deep on the longest agent  ≈ 180s per arm
     *   + the arms overlapping rather than queueing  ≈ 250s on the critical path
     *
     * 900s is not that number rounded up; it is the ceiling, chosen because everything between
     * 250s and it is headroom for a slow model and there is nothing to spend it on. Note that
     * `src/demo/run.ts` runs the two arms **sequentially** today, which doubles the middle line
     * of that arithmetic to roughly 500s — still inside 900s, which is the point of taking the
     * maximum rather than a tight fit.
     *
     * Raising it is safe in the one way that matters: `infra/lambda/runner.ts` derives the
     * watchdog budget from `getRemainingTimeInMillis()`, so the terminal event still fires
     * before the sandbox is killed, and it fires on a run that has genuinely stalled rather
     * than on one that was merely slow. A terminal event that fires on healthy runs is worse
     * than none, because a page would learn to ignore it.
     *
     * 1024MB rather than 512: Lambda scales CPU with memory, five agents run concurrently
     * inside one sandbox, and a run that finishes sooner holds one of ten account-wide
     * concurrency slots for less time. At the handful of runs this demo will serve, the cost
     * difference is cents.
     */
    const runnerFn = new lambda.Function(this, 'RunnerFn', {
      ...runtime,
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      code: lambda.Code.fromAsset(path.join(DIST, 'runner')),
      environment: {
        CORTEX_DEMO_DSN: demoDsn,
        CONNECTIONS_TABLE: connections.tableName,
        WEBSOCKET_CALLBACK_URL: streamStage.callbackUrl,
        SQL_LOG_TABLE: sqlLog.tableName,
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_EMBED_MODEL: embedModel,
        // Where `infra/bundle.mjs` put `bench/demo-app/`. Lambda unpacks the asset at
        // `/var/task`, so the corpus sits beside the handler rather than two directories above
        // it, and `src/demo/patches.ts` has no repository to resolve itself against.
        CORTEX_CORPUS_ROOT: '/var/task',
        // The runner gets the token too, because the function that spends the money is the one
        // that has to be able to refuse. `POST /demo/run` authorises, and then invokes this
        // function with a payload it cannot authenticate — so LIVE mode arriving as a field in
        // that payload is a claim, not a proof, and re-checking it here is what makes it one.
        // At the time of writing the runner does not read this variable; it is present so that
        // wiring the check is a code change rather than a redeploy.
        LIVE_TOKEN: liveToken,
      },
    });
    connections.grantReadWriteData(runnerFn);
    sqlLog.grantReadWriteData(runnerFn);
    // Embeddings, and **deliberately in a different policy from reasoning**. This is the
    // runner's own inline role policy: dedupe, recall and consolidation all embed, and none of
    // them is LIVE-only, so this grant must survive the LIVE brake being pulled. The reasoning
    // grant is a separate managed policy further down for exactly that reason — see
    // `LiveReasoningPolicy`.
    runnerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${bedrockRegion}::foundation-model/${embedModel}`,
          `arn:aws:bedrock:${bedrockRegion}:${this.account}:inference-profile/${embedModel}`,
        ],
      }),
    );
    runnerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          this.formatArn({
            service: 'execute-api',
            resource: webSocketApi.apiId,
            resourceName: `${streamStage.stageName}/POST/@connections/*`,
          }),
        ],
      }),
    );

    /**
     * **THE LIVE BRAKE.** `04` §5 brake 3 asks for an action that "MUST target the LIVE
     * reasoning function and nothing else", and says in the same breath that a brake wired to
     * disable the API, the SPA, the read path or the cluster converts a cost control into a
     * **rules violation**, because B4 requires this project to stay available, free and
     * unrestricted, until 2026-09-15. So the brake cannot be "turn the function off".
     *
     * It is this policy, and the only thing it can take away is the ability to invoke a
     * reasoning model.
     *
     * **This is the action, not the whole of brake 3.** §5 wants an AWS Budget that fires it
     * automatically above a low-double-digit threshold, and there is no Budget resource in this
     * stack — firing it is a human decision today. When one is added it must filter on `Claude
     * Sonnet 4.5 (Amazon Bedrock Edition)`, or whatever the fleet model's equivalent service
     * name turns out to be: Cost Explorer bills reasoning under a service distinct from
     * `Amazon Bedrock`, which carries only the Titan embedding line (V36). A Budget watching
     * `Amazon Bedrock` would never fire.
     *
     * **How an operator fires it.** Both `RunnerRoleName` and `LiveReasoningPolicyArn` are
     * stack outputs so the command can be assembled without reading this file:
     *
     *   $ aws iam detach-role-policy --role-name <RunnerRoleName> \
     *       --policy-arn <LiveReasoningPolicyArn>
     *
     * It takes effect on the next invocation, needs no deploy and no bundle. Re-attaching it
     * with `attach-role-policy` restores LIVE. **A later `cdk deploy` re-attaches it too** —
     * that is CloudFormation doing its job, not a bug, and it is why there is a second, durable
     * form of the same brake: `cdk deploy -c liveReasoning=false` synthesizes a stack with no
     * such policy at all. Use the detach for a spike, the context flag for the rest of the
     * event.
     *
     * **What a visitor sees.** Everything they saw before, minus authored code. `modelAuthor`
     * (`src/demo/author.ts`) falls back to `committedAuthor` on every path where a call cannot
     * be made or its result cannot be trusted, and an `AccessDeniedException` is one of those
     * paths — `test/author.test.ts` is the guard on that fallback. So the run still runs, both
     * arms still contend, the changefeed still fires, and the content of each patch comes from
     * committed text instead of from a model: `04` §5 rung 1, LIVE degrading to REPLAY, no
     * error page and no credential prompt. Nothing else on this account loses a permission —
     * the embedding grant above is in a different policy, and no other function is attached to
     * this one.
     */
    const liveReasoningEnabled = String(this.node.tryGetContext('liveReasoning') ?? 'true') !== 'false';
    const runnerRole = runnerFn.role;
    if (!runnerRole) {
      throw new Error('the runner has no execution role, so the LIVE brake has nothing to attach to');
    }

    if (liveReasoningEnabled) {
      const liveReasoningPolicy = new iam.ManagedPolicy(this, 'LiveReasoningPolicy', {
        description:
          'LIVE reasoning for the fleet runner. Detach to stop LIVE model calls without taking ' +
          'any other capability with it (04 section 5, rule B4).',
        statements: [
          new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: inferenceProfileGrant(this.account, fleetReasonModel),
          }),
        ],
        // The runner and nothing else. The demo router, the changefeed sink, the connections
        // handler and the identity probe have no business authoring code, and a grant they do
        // not hold is one nobody has to remember to revoke.
        roles: [runnerRole],
      });

      new cdk.CfnOutput(this, 'LiveReasoningPolicyArn', {
        value: liveReasoningPolicy.managedPolicyArn,
        description: 'Detach this from RunnerRoleName to stop LIVE reasoning and nothing else.',
      });
    }

    new cdk.CfnOutput(this, 'RunnerRoleName', {
      value: runnerRole.roleName,
      description: 'The role LiveReasoningPolicyArn attaches to.',
    });

    // Named after the fact rather than at construction because the runner needs the WebSocket
    // stage, which needs the connections function — and the route handler needs the runner. One
    // of the three has to learn its neighbour's name late; this is the cheapest one.
    demoFn.addEnvironment('RUNNER_FUNCTION', runnerFn.functionName);
    runnerFn.grantInvoke(demoFn);

    const api = new apigw.HttpApi(this, 'DemoApi', {
      // Anonymous and cross-origin by construction: the SPA is served from CloudFront and
      // calls this API directly. `05` §5 makes the surface public — there is no cookie,
      // no credential and nothing an origin check would protect.
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type'],
      },
    });

    api.addRoutes({
      path: '/identity',
      methods: [apigw.HttpMethod.GET],
      integration: new apigwIntegrations.HttpLambdaIntegration('IdentityIntegration', identityFn),
    });

    api.addRoutes({
      path: '/demo/{proxy+}',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST, apigw.HttpMethod.OPTIONS],
      integration: new apigwIntegrations.HttpLambdaIntegration('DemoIntegration', demoFn),
    });

    // The changefeed's webhook sink. Public because CockroachDB Cloud reaches it from
    // outside this account, and authenticated inside the handler against
    // `webhook_auth_header` — see `src/demo/stream.ts` for why that is not optional.
    api.addRoutes({
      path: '/changefeed',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwIntegrations.HttpLambdaIntegration('ChangefeedIntegration', changefeedFn),
    });

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'IdentityUrl', { value: `${api.apiEndpoint}/identity` });
    new cdk.CfnOutput(this, 'ChangefeedSink', { value: `${api.apiEndpoint}/changefeed` });
    new cdk.CfnOutput(this, 'StreamUrl', { value: streamStage.url });
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ConcurrencyBudget', { value: JSON.stringify(CONCURRENCY) });
  }
}
