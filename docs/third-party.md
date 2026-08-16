# Third-party dependencies and licences

Everything CORTEX depends on, and under what terms. Nothing listed here is vendored:
`node_modules/` and the esbuild Lambda bundle are gitignored, and no third-party source
file is committed to this repository.

CORTEX itself is **MIT** (`LICENSE`, and the `license` field in `package.json`).

Licence identifiers below are read from each installed package's own `package.json`.
Regenerate the tallies with the commands in [§4](#4-how-these-numbers-were-produced);
last generated 2026-08-13.

---

## 1. Direct dependencies

### Runtime (`dependencies`)

| Package                                        | Version   | Licence    | Why it is here                                          |
| ---------------------------------------------- | --------- | ---------- | ------------------------------------------------------- |
| `pg`                                           | 8.22.0    | MIT        | the PostgreSQL wire driver; every connection to CockroachDB |
| `@aws-sdk/client-bedrock-runtime`              | 3.1106.0  | Apache-2.0 | Titan Text Embeddings V2, and Claude via the Converse API |
| `@aws-sdk/client-apigatewaymanagementapi`      | 3.1107.0  | Apache-2.0 | pushing changefeed rows out over the WebSocket API      |
| `@aws-sdk/client-dynamodb`                     | 3.1107.0  | Apache-2.0 | the WebSocket connection registry                       |
| `@aws-sdk/lib-dynamodb`                        | 3.1107.0  | Apache-2.0 | document-shaped access to the same registry             |
| `@modelcontextprotocol/sdk`                    | 1.30.0    | MIT        | the CORTEX MCP server on stdio (`cortex_propose`, `cortex_close`) |
| `@anthropic-ai/sdk`                            | 0.115.0   | MIT        | Anthropic client types used alongside the Bedrock path  |

### Development (`devDependencies`)

| Package        | Version  | Licence    | Why it is here                              |
| -------------- | -------- | ---------- | ------------------------------------------- |
| `typescript`   | 7.0.2    | Apache-2.0 | `npx tsc --noEmit`, the first thing a clone runs |
| `vitest`       | 4.1.10   | MIT        | the test suite, run against the real cluster |
| `tsx`          | 4.23.1   | MIT        | runs every `scripts/*.mts` entry point      |
| `@types/node`  | 26.1.2   | MIT        | type definitions                            |
| `@types/pg`    | 8.20.2   | MIT        | type definitions                            |

### Infrastructure (`infra/cdk/package.json`, a separate npm project)

| Package        | Range      | Licence    | Why it is here                        |
| -------------- | ---------- | ---------- | ------------------------------------- |
| `aws-cdk-lib`  | ^2.263.0   | Apache-2.0 | the `CortexStack` construct library   |
| `constructs`   | ^10.5.0    | Apache-2.0 | CDK's construct base                  |
| `aws-cdk`      | 2.1135.1   | Apache-2.0 | the `cdk` CLI (dev)                   |
| `typescript`, `tsx`, `jest`, `@swc/*`, `@types/*` | various | MIT / Apache-2.0 | build and test of the CDK app (dev) |

## 2. The transitive tree

Counted over every installed package, licence taken from its declared `license` field.

**Root project, production closure — 151 packages:**

| Licence      | Packages |
| ------------ | -------: |
| MIT          |      104 |
| Apache-2.0   |       33 |
| ISC          |        9 |
| BSD-3-Clause |        2 |
| BSD-2-Clause |        1 |
| Unlicense    |        1 |
| 0BSD         |        1 |

Every one is a permissive licence. **No copyleft licence appears in what ships**, and no
package in the production closure omits a licence declaration.

**Root project including devDependencies — 210 packages:** the same set plus
`MPL-2.0: 2` (`lightningcss` and its darwin-arm64 binary, pulled in by the test runner's
CSS handling). MPL-2.0 is file-level copyleft; both packages are build-time tools, are
not modified, and are not redistributed by this project.

**`infra/cdk/` including devDependencies — 333 packages:** MIT 253, ISC 39, Apache-2.0 19,
BSD-3-Clause 12, BlueOak-1.0.0 5, and one each of `Apache-2.0 AND MIT`,
`(MIT OR GPL-3.0-or-later)`, `(MIT OR CC0-1.0)`, `CC-BY-4.0` and BSD-2-Clause. All are
CDK build tooling; nothing from this tree is deployed as application code, and the
dual-licensed entries can be taken under their permissive option.

## 3. Hosted services

Used over the network. No source or binary of any of these is redistributed here, so
their licences do not attach to this repository.

| Service                                 | How it is used                                                           |
| --------------------------------------- | ------------------------------------------------------------------------ |
| **CockroachDB Cloud** (Basic tier)       | the entire memory layer. The cluster self-reports `CockroachDB CCL v26.2.5`. |
| **Amazon Bedrock**                       | Titan Text Embeddings V2 for every embedding. Claude Sonnet 4.5 is invoked only from a developer machine, to record cassettes and to probe entitlement — no deployed function holds a grant to invoke it. |
| **AWS Lambda, API Gateway, S3, CloudFront, DynamoDB, Secrets Manager, CloudWatch** | the deployed demo, its stream and its secrets. AWS Budgets is named in the design as a cost brake and is **not built**. |

**`cockroachlabs/cockroachdb-skills`** is named in `spec/` as a skill the agent consumes
during development. Nothing from it is copied into this repository; CORTEX publishes its
own skill instead (`skills/cortex-memory/SKILL.md`), which is original work.

## 4. How these numbers were produced

```bash
npm ci                                        # root project
npm --prefix infra/cdk ci                     # CDK app

# production closure of the root project
npm ls --omit=dev --all --parseable | tail -n +2 | sort -u
```

Each path from that listing has its `package.json` read and its `license` field tallied;
the full-tree counts walk `node_modules/` (including nested `node_modules/`) and tally the
same field. A package that declares nothing is counted as `UNDECLARED` — there are none in
the production closure.

Direct-dependency versions above are the installed versions, not the `package.json`
ranges; `package-lock.json` is committed and is what `npm ci` resolves.
