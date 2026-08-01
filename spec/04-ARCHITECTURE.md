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
      └──MCP(read)───────────────────────────────────────────────────►   ├ intents
         CockroachDB Cloud Managed MCP Server (read-only sa)              ├ findings
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

Infrastructure as code: a single CDK or SAM app in `infra/`. `[OPEN]` CDK gives
better ergonomics and a nicer diagram story; SAM is smaller and faster to deploy. The
implementer should pick based on which they can deploy reliably in under ten minutes,
because deployment friction on day three is what kills hackathon submissions.

## 3. Privilege planes

This is the section judges read for the Product Readiness criterion. Two service
accounts, two capabilities, no overlap.

| Plane | Principal | Grants | Route |
| --- | --- | --- | --- |
| **Read** | `cortex_reader` | `SELECT` on all four tables | agents → CockroachDB Cloud Managed MCP Server (read-only mode, audit logged) |
| **Write** | `cortex_writer` | `INSERT`, `UPDATE`, `DELETE` on the four tables, nothing else | agents → CORTEX MCP tools → Lambda → SQL |

Properties that follow, and that you should state explicitly:

- The agent never holds write credentials. A prompt-injected agent cannot corrupt the
  fleet's memory, because it has no verb with which to do so.
- Every read the agent performs is audited by the managed MCP server, not by
  application code you wrote and could have got wrong.
- The write surface is a small, typed, parameterised set of operations. No arbitrary
  SQL is reachable from any agent-controlled input.
- The demo's public write path is a third, further-restricted principal with a
  per-session row cap.

## 4. Data flows

**Flow A — agent starts a task.** Agent calls RECALL through the managed MCP server →
receives up to eight findings ordered by prior failure count → incorporates them into
its plan. No write occurs.

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
   low-double-digit threshold.

Additionally: the smallest adequate model, a tight `max_tokens`, and embedding results
cached by content hash so a repeated intent never pays twice.

The model credentials live only in the Lambda execution environment. They are never
sent to the browser, never present in the REPLAY path, and never required from a
visitor. The demo remains free and unrestricted for judges, which is a rules
requirement, while the exposure stays bounded.

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
| Demo cost cap hit | LIVE disabled | automatic fallback to REPLAY with an on-screen explanation |
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
