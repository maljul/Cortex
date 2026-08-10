# 04 — Architecture

## 1. Component map

```
DEVELOPER MACHINE                          AWS                          COCKROACHDB CLOUD
─────────────────                          ───                          ─────────────────
coding agents  ──MCP(write)──►  API Gateway HTTP
(Claude Code,                       │
 Codex, scripted)                   ▼
      │                     Lambda: memory-write ──SQL(rw sa)──────────►  cluster
      │                            │                                      ├ claims
      └──SQL(cortex_reader, SELECT only)──────────────────────────────►   ├ intents
         the Agent Skill's recall query, §3                               ├ findings
                                                                          └ action_ledger
cortex CLI ──ccloud CLI──► CockroachDB Cloud control plane                  │
                                                                               │ changefeed
                                    API Gateway HTTP (webhook sink) ◄──────────┘
                                            │
                                            ▼
                                    EventBridge ──► Lambda: consolidate ──SQL──► findings
                                            │
                                            └────► Lambda: ws-fanout ──► API Gateway WebSocket
                                                                              │
CloudFront + S3 (demo SPA) ◄──────────────────────────────────────────────────┘

Bedrock: Claude (Converse) for reasoning, Titan Text Embeddings V2 for vectors
S3: cassettes, fixtures, benchmark results
CloudWatch + AWS Budgets: logs, metrics, hard cost ceiling
```

## 2. Deployment

Everything hosted runs on AWS. This is a hard requirement, not a preference: the
challenge statement requires the project to be deployed on AWS.

| Surface | Service | Notes |
| --- | --- | --- |
| Demo front end | S3 + CloudFront | static SPA, no server rendering |
| Write path | API Gateway HTTP + Lambda | typed tools, no arbitrary SQL exposed |
| Live memory stream | API Gateway WebSocket + Lambda | pushed, not polled |
| Changefeed ingress | API Gateway HTTP | webhook sink target |
| Consolidation | EventBridge + Lambda | asynchronous, off critical path |
| Reasoning and embeddings | Bedrock | LIVE mode only for reasoning; embeddings always |
| Artifacts | S3 | cassettes, fixtures, results |
| Guardrails | CloudWatch + AWS Budgets | see §5 |

No long-lived compute anywhere. The earlier idea of an ECS container holding an open
core changefeed connection is rejected: it costs money continuously and adds an
availability dependency for zero benefit.

Infrastructure as code: a single **CDK** app in `infra/`. *(Decided 2026-08-10 on the
strength of V22; was `[OPEN]` between CDK and SAM.)* Both were built and both were
timed, and the ten-minute criterion this section proposed **did not separate them** —
each redeploys in well under a minute. CDK was chosen on what the source looked like
rather than on the clock: CloudFront with an origin access control is eight lines of CDK
and about fifty of raw CloudFormation under SAM, and the resources still to come — a
WebSocket API, EventBridge, the changefeed sink, reserved concurrency, a budget alarm —
widen that gap rather than close it. Numbers in `docs/verification-log.md` V22,
reasoning in `docs/DECISIONS.md`.

**The DSN is a CloudFormation dynamic reference, not an environment value.** V22 found
the first arrangement writing the reader DSN into the synthesized template, where it sat
in `cdk.out/` and in CloudFormation's stored copy. `{{resolve:secretsmanager:...}}`
keeps it in Secrets Manager and out of both.

## 3. Privilege planes

This is the section judges read for the Product Readiness criterion. Two service
accounts, two capabilities, no overlap.

| Plane | Principal | Grants | Route |
| --- | --- | --- | --- |
| **Read** | `cortex_reader` | `SELECT` on all six tables, and no write verb | agents → `CORTEX_READER_DSN` → SQL (the Agent Skill's recall query) |
| **Write** | `cortex_writer` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the six tables, nothing else | agents → CORTEX MCP tools → Lambda → SQL |
| **Demo write** | `cortex_demo` | `INSERT`, `UPDATE`, `DELETE` confined to demo session scopes, nothing else | anonymous browser → API Gateway → demo Lambda → SQL |

Two clarifications, both learned by applying the grants against a live cluster
rather than by reasoning about them:

- **The write plane needs `SELECT`.** Flow B returns "the holder's identity and
  prior outcome" on a blocked claim, which is a read; `INSERT … RETURNING`
  requires the privilege regardless. What makes the write plane safe is not the
  absence of `SELECT` but that it is reachable only through a small typed
  parameterised surface. The security claim rests on `cortex_reader` holding no
  write verb, and that direction is exactly enforced.
- **Six tables, not four.** There are four memory tiers but six tables: `repos`
  and `agents` are identity, and both planes need them to resolve a claim to its
  holder. Earlier drafts said "four" by counting tiers.
- **The read route is `cortex_reader` directly, not the CockroachDB Cloud Managed
  MCP Server.** *(Changed 2026-08-10 on the strength of V17.)* That server was the
  route here until it was measured. It executes as SQL user `managed-mcp`, which
  holds `INSERT` and `DELETE` on `claims` and `INSERT` on `intents` — confirmed by
  invoking `insert_rows` and getting **23502**, a constraint violation, rather than
  **42501**: the privilege check passed and only the row was refused. It also
  publishes `insert_rows`, `create_table` and `create_database` as tools. An agent
  given that endpoint for recall would hold an unarbitrated write path into the two
  tables arbitration exists to protect, and would bypass every `03` §8 invariant
  rather than break one, because it would never call `cortex_propose` at all.

Properties that follow, and that you should state explicitly:

- The agent never holds write credentials. A prompt-injected agent cannot corrupt the
  fleet's memory, because it has no verb with which to do so.
- The read plane's read-only property is enforced by a SQL grant and **asserted by
  test**: `test/privilege-planes.test.ts` attempts an `INSERT` on all six tables as
  `cortex_reader`, plus an `UPDATE`, a `DELETE` and a `DROP`, and requires every one
  to refuse with SQLSTATE 42501. It reads no catalogue — V9 found all three service
  accounts holding `admin` through a role membership that `SHOW GRANTS ON TABLE`
  answered truthfully without revealing. State this as the claim, and state that it
  is a claim you can run rather than one you are asked to believe.
- The write surface is a small, typed, parameterised set of operations. No arbitrary
  SQL is reachable from any agent-controlled input.

### The demo principal and its blast radius

The hosted demo MUST write as `cortex_demo`, a principal distinct from
`cortex_writer`. This is not tidiness. The two planes have different threat models,
and collapsing them would put an anonymous visitor behind the same principal that
governs real repository memory.

| | CLI write plane | Demo write plane |
| --- | --- | --- |
| Whose cluster | the user's own, provisioned by `cortex init` | yours, and it must survive until 2026-09-15 |
| Who can reach it | the user's own agents, on their own machine | anyone on the internet, anonymously, with no account |
| Who supplies the credential | the user, for their own repository | nobody: the credential is server side only and is never requested |
| Worst realistic case | the user damages their own repository's memory | one throwaway sandbox scope is damaged |

Invariants, in descending order of what a breach costs you:

- `cortex_demo` MUST NOT be `cortex_writer`, and MUST NOT hold the reader plane's
  grants. A demo visitor cannot become an agent, and an agent cannot become a visitor.
- `cortex_demo` MUST NOT be able to affect any row whose `repo_id` is not a live demo
  session scope. Real repository memory is not merely filtered out of the demo's
  queries; it MUST be unreachable to the principal.
- Demo session scopes are ephemeral and row-capped. See `03-MEMORY-MODEL.md` §7.
- One demo session MUST NOT read or write another's. **The vector index prefix does
  not give this** — V5 in `docs/verification-log.md` measured a query without the
  `repo_id` filter falling back to a full scan and returning the other scope's rows,
  so the prefix fails open. Both the read and the write path MUST scope every
  statement, and the principal MUST be unable to reach beyond a live session scope
  even when a statement is wrong. That is a constraint on the `[OPEN]` decision
  below, not a property already in hand.

`[OPEN]` How that confinement is enforced. A dedicated cluster for the demo gives
isolation you do not have to reason about, but it is a second free-tier cluster to
keep alive through judging, which doubles the surface of the longevity risk that is
already the most likely way this submission fails after submission. Demo-scoped
`repo_id`s in the one cluster keep a single thing alive and keep the architecture
story honest — one cluster, as the whole thesis claims — but then the confinement
rests on the write path rather than on the account boundary. The implementer should
pick, state which, and write the test named in `03-MEMORY-MODEL.md` §8 either way.

## 4. Data flows

**Flow A — agent starts a task.** Agent issues the recall query as `cortex_reader` →
receives up to eight findings ordered by prior failure count → incorporates them into
its plan. No write occurs, and none is possible: the principal holds no write verb
(§3).

**Flow B — agent wants to act.** Agent calls `cortex.propose` on the CORTEX MCP
server → Lambda embeds the intent via Bedrock Titan → runs the single arbitration
transaction → returns `granted`, `deduped` or `blocked` with the holder's identity and
prior outcome.

**Flow C — agent finishes.** Agent calls `cortex.close` → Lambda commits outcome,
ledger entry and claim release in one transaction.

**Flow D — consolidation.** Changefeed on `intents` emits the transition to `done` →
webhook sink hits API Gateway → EventBridge → consolidation Lambda embeds the outcome
and either reinforces an existing finding or inserts a new one.

**Flow E — live view.** The same changefeed events fan out over WebSocket to the demo
UI, so the memory panel updates from the database's own change stream rather than
from application-side echoes. This matters: the UI is showing what committed, not
what the app believes it sent.

## 5. Cost model and guardrails

Target: single-digit dollars for the whole hackathon and judging period.

| Item | Expected cost |
| --- | --- |
| CockroachDB free tier | 0, with large headroom at demo volumes |
| Lambda, API Gateway, S3, CloudFront | 0 within free tier at demo volumes |
| Bedrock embeddings | cents; embeddings are short and cached by content hash |
| Bedrock reasoning, LIVE mode | the only real variable; capped, see below |

Three independent brakes on LIVE mode, all of which must be implemented:

1. **Reserved concurrency of 2** on the LIVE Lambda. A traffic spike physically
   cannot fan out.
2. **A run counter in CockroachDB**, default 40 LIVE runs per day globally. On
   exhaustion the UI switches to REPLAY and says so plainly.
3. **An AWS Budget alarm** with an action that disables the LIVE function above a
   low-double-digit threshold. Its action MUST target the LIVE reasoning function and
   nothing else. A brake wired to disable the API, the SPA, the read path or the
   cluster converts a cost control into a rules violation, because rule B4 requires
   the project to stay available until 2026-09-15.

Additionally: the smallest adequate model, a tight `max_tokens`, and embedding results
cached by content hash so a repeated intent never pays twice.

The model credentials live only in the Lambda execution environment. They are never
sent to the browser, never present in the REPLAY path, and never required from a
visitor. The demo remains free and unrestricted for judges, which is a rules
requirement, while the exposure stays bounded.

### Degradation ladder

Rule B4 requires the working project to be available to judges free of charge and
without restriction until 2026-09-15. An error page and a credential prompt fail that
requirement equally, so **every limit this system can reach MUST resolve to a working
page rather than to a failure.** Four limits are reachable. Each has a rung.

| Rung | Limit reached | Behaviour | What is still true |
| --- | --- | --- | --- |
| 1 | LIVE reasoning quota exhausted | switch to REPLAY and state the reason on screen | database behaviour fully live |
| 2 | Bedrock embeddings throttled or unavailable | deterministic local hash embedding, intent marked `degraded`, dedupe skipped for that intent | database behaviour fully live, dedupe degraded and labelled as such |
| 3 | per-session row cap reached | session becomes read-only; its rows, counters and SQL log stay inspectable; a new session is one click | everything on screen is still real |
| 4 | cluster or write path unavailable | serve the pre-recorded walkthrough from S3 and CloudFront behind an explicit banner | nothing is live, and the banner says so |

Note that rung 2 is reachable in REPLAY as well as in LIVE. REPLAY caches reasoning,
not embeddings, so the demo retains a Bedrock dependency even with LIVE disabled
entirely. This is the rung most likely to fire unnoticed.

Invariants:

1. No rung MAY present an error page, a credential field, a login, or a payment gate.
   This holds however the limit was reached and whoever reached it.
2. No rung MAY misrepresent liveness. Rung 4 MUST state that database behaviour is not
   live, for the same reason REPLAY carries its notice: rule A7 requires the project to
   function as depicted, and a silent static fallback would depict a live system.
3. Degradation affects only the capability that hit its limit. An exhausted LIVE quota
   MUST NOT disable the read path; a full session MUST NOT take down the SPA.
4. Every rung MUST be verified by forcing its limit, not by reasoning about it. The
   done-when condition is in `08-BUILD-PLAN.md` §5.

## 6. Failure modes

Judges specifically look for "what happens when things go wrong". Document each of
these in the README with the mitigation next to it.

| Failure | Behaviour | Mitigation |
| --- | --- | --- |
| Agent process dies holding claims | claims expire | Row-level TTL sweeps every minute; no manual recovery |
| Serialization conflict under load | transaction retried | bounded retry with jitter; retry count surfaced as a metric |
| Bedrock throttled or unavailable | intent cannot be embedded | fall back to a deterministic local hash embedding, mark the intent `degraded`, skip dedupe for it rather than blocking the agent |
| Changefeed stalled | consolidation lags, live view freezes | agents are unaffected because consolidation is off the critical path; UI shows a staleness badge driven by the last event timestamp |
| Cluster unreachable | agents cannot claim | CLI fails closed: no claim means no action, never act without arbitration |
| Demo LIVE quota exhausted | LIVE disabled, REPLAY unaffected | ladder rung 1; the Budget alarm may disable the LIVE function and nothing else |
| Demo session row cap reached | that session goes read-only | ladder rung 3; its state stays inspectable and a new session is one click |
| Demo backend unavailable | no live data | ladder rung 4; pre-recorded walkthrough from CloudFront behind a banner stating it is not live |
| Prompt-injected agent | attempts a destructive write | impossible: the agent's credentials permit no writes and the write API exposes no arbitrary SQL |

Note the deliberate choice in row five. **Fail closed.** An agent that cannot reach
its memory must stop, not proceed unarbitrated. That is precisely the sponsor's own
framing about agents whose memory goes offline, and it is worth one sentence in the
video.

## 7. Observability

- Structured JSON logs to CloudWatch from every Lambda, correlated by `intent_id`.
- Metrics: claim latency p50 and p95, dedupe hit rate, block rate, `40001` retries,
  consolidation lag, tokens saved.
- The demo UI displays claim p50 and the retry counter live. Numbers on screen are
  worth more than a claim in prose.
- `[OPEN]` OpenTelemetry export is nice but not free in build time. Decide on day
  three based on remaining hours; CloudWatch alone is sufficient for the criterion.

## 8. Unverified assumptions

Resolve all three before writing dependent code. Each has a named fallback so no
assumption can block the build.

| # | Assumption | Fallback if false |
| --- | --- | --- |
| V1 | Vector indexes are creatable on the free tier after enabling the cluster setting | brute-force ordering without an index on a small corpus; the demo dataset is small enough that recall stays fast, and the README documents the index as the scale path |
| V2 | Sink-based changefeeds with a webhook sink are available on the free tier | EventBridge Scheduler invoking a Lambda every two seconds that reads rows newer than a watermark; uglier, cheaper, sufficient |
| V3 | The historical-query window is long enough for the time-travel panel | drop time travel from the demo; the append-only `intents` table already carries the audit story |
