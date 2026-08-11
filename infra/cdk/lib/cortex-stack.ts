/**
 * The CORTEX deployment. One CDK app in `infra/`, per `04` §2.
 *
 * This was `infra/cdk-spike/` until U14. B2 built it to burn down one risk — can a
 * Lambda reach CockroachDB Cloud at all — and the answer was yes with no VPC, no custom
 * CA and a warm query at 3ms (V22). What it deployed is still here, renamed rather than
 * rewritten, because "spike" stopped being true the moment the demo depended on it.
 *
 * Four functions, and the concurrency they share is the binding constraint on this whole
 * deployment. See `CONCURRENCY` below before adding a fifth.
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
 * So all four functions draw on one shared pool of 10, and the budget is a statement
 * about what is expected to be in flight rather than a limit any of them can exceed:
 *
 *   demo        — the visitor-facing route. Every panel refresh is one invocation.
 *   changefeed  — one at a time in practice; the sink posts batches, not rows.
 *   connections — $connect / $disconnect only, and both are sub-millisecond.
 *   identity    — a curl target for the README and the video. Effectively idle.
 *
 * Ten simultaneous visitors can still exhaust it, and the fifth rung U17 has to build is
 * what answers when they do. Nothing here pretends otherwise.
 */
const CONCURRENCY = { accountLimit: 10, reservedPerFunction: 'unavailable on this account' };

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

    const demoFn = new lambda.Function(this, 'DemoFn', {
      ...runtime,
      code: lambda.Code.fromAsset(path.join(DIST, 'demo')),
      environment: { CORTEX_DEMO_DSN: demoDsn },
    });

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
      environment: {
        CORTEX_DEMO_DSN: demoDsn,
        CONNECTIONS_TABLE: connections.tableName,
        WEBSOCKET_CALLBACK_URL: streamStage.callbackUrl,
        CHANGEFEED_TOKEN: changefeedToken,
      },
    });
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
