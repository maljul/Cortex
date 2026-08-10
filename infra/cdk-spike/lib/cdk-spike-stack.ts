/**
 * The CDK half of the deploy spike (`08` §7, `04` §2's `[OPEN]`).
 *
 * Deliberately the same four resources as `infra/sam-spike/template.yaml`, from the
 * same pre-bundled artifact in `infra/lambda-dist/`, so the timed comparison measures
 * the tool and not the stack. `index.html` is uploaded by `aws s3 cp` outside both
 * stacks for the same reason — SAM has no BucketDeployment equivalent, so building one
 * here would have compared CDK's convenience against SAM's absence of it.
 */
import * as cdk from 'aws-cdk-lib/core';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import * as path from 'node:path';

export class CdkSpikeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The DSN is a CloudFormation **dynamic reference**, not a value. `secretsManager()`
    // synthesizes `{{resolve:secretsmanager:...}}`, which CloudFormation resolves at
    // deploy time, so the secret never enters the template, `cdk.out/`, or the
    // CloudFormation API's stored copy of either.
    //
    // This replaced reading `process.env.CORTEX_READER_DSN` at synth time, which was
    // measured doing exactly what it looked like it did: `grep sslmode` against
    // `cdk.out/CdkSpikeStack.template.json` matched. That is V22's finding, and it is
    // why the first arrangement is not merely tidied away here but named.
    //
    // `unsafeUnwrap` is the correct call despite its name: it is unsafe precisely
    // because it puts the token into the template, and the token is what we want there.
    // The secret is created out of band (`aws secretsmanager create-secret`) so its
    // value passes from the shell to Secrets Manager without touching this repository.
    const dsn = cdk.SecretValue.secretsManager('cortex/reader-dsn').unsafeUnwrap();

    const fn = new lambda.Function(this, 'IdentityFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambda-dist')),
      // 15s is a spike number chosen to expose a hang rather than absorb it: the pool
      // in `src/db/pool.ts` gives up on connecting at 10s, so a timeout here means the
      // handler never returned, not that the cluster was slow to answer.
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: { CORTEX_DSN: dsn },
    });

    const api = new apigw.HttpApi(this, 'SpikeApi');
    api.addRoutes({
      path: '/identity',
      methods: [apigw.HttpMethod.GET],
      integration: new apigwIntegrations.HttpLambdaIntegration('IdentityIntegration', fn),
    });

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      // A spike is torn down; leaving a retained bucket behind would make the loser's
      // `cdk destroy` a partial one and quietly cost money past 2026-09-15.
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

    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.apiEndpoint}/identity` });
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
