# `infra/cdk` — the CORTEX deployment

The single CDK app `04` §2 calls for. One stack, `CortexStack`, in `us-east-1`.

This was `infra/cdk-spike/` until U14. B2 built it to answer one question — can a Lambda
reach CockroachDB Cloud at all — and the answer was yes, with no VPC, no custom CA and a
warm query at 3ms (V22). What it deployed is still here, renamed rather than rewritten.

## Deploying

Order matters on a fresh account, and the first step is the one that is easy to skip:

```sh
npm run deploy:secrets          # from the repo root — puts the DSN and the changefeed
                                # token in Secrets Manager. The stack references them as
                                # {{resolve:secretsmanager:...}}, so a missing secret
                                # fails the deploy with a resolve error, and the
                                # tempting fix at that moment is to paste the value into
                                # the stack. Do not.

node infra/bundle.mjs           # NOTHING RUNS THIS AUTOMATICALLY. A stale bundle
                                # deploys silently, which is why every handler carries a
                                # BUNDLE_REVISION you bump by hand.

cd infra/cdk && npx cdk deploy CortexStack --require-approval never

npm run deploy:site             # uploads infra/site/ with the stack's endpoints injected
npm run changefeed create       # starts the feed that drives the live view
npm run gate:stream             # proves a committed row reaches a browser socket
```

## What is in the stack

| Resource | Why |
| --- | --- |
| `DemoFn` + HTTP API `/demo/{proxy+}` | `05` §5's session and state routes, anonymous |
| `IdentityFn` + `/identity` | the cluster's own build string, as `cortex_demo` |
| `ChangefeedFn` + `POST /changefeed` | the webhook sink, authenticated in the handler |
| `ConnectionsFn` + WebSocket API | `$connect` / `$disconnect` for the live view |
| `Connections` (DynamoDB) | connection ids only — not memory, see `docs/DECISIONS.md` |
| S3 + CloudFront | the demo page, no server rendering |

## Two things to know before changing it

**No function carries reserved concurrency, and none can.** This account's Lambda limit is
10 and AWS refuses any reservation that drops unreserved concurrency below 10, so `04`
§5's brake 1 is not implementable here. The budget is written out in `lib/cortex-stack.ts`;
V26 has the API's refusal verbatim.

**No credential belongs in this directory.** Both DSN-shaped values are dynamic
references resolved by CloudFormation at deploy time. V22 found the first arrangement
writing one into `cdk.out/`, and it was found by grepping the artifact rather than by
reasoning about the rule — so grep the artifact:

```sh
grep -rE "sslmode|postgresql://" cdk.out/*.template.json     # must match nothing
```
