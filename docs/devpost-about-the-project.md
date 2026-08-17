# Devpost — "About the project" field

**Paste everything below the rule.** Devpost renders Markdown with LaTeX: `\\( … \\)`
inline, `$$ … $$` displayed. Both are used below and both are load-bearing — the threshold
ordering is the actual design constraint in `src/memory/recall.ts`, and the backoff formula
is literally the expression in `src/db/retry.ts:83`.

**How this file relates to `docs/submission-devpost.md`.** That file is U20's artifact and
stays the source for the **B10** (CockroachDB tools) and **B11** (AWS services) answer
fields — its §2 and §3. Its §1 is an earlier long-form description written to `07` §6's
structure. **This file is the seven-heading "About the project" story field and is the one
to paste there.** Where the two overlap they agree; if they ever disagree, the numbers in
both come from `bench/results/2026-08-12T18-35-38-014Z/summary.md` and that directory wins.

**Benchmark provenance.** Every number below is the committed median from
`bench/results/2026-08-12T18-35-38-014Z/`. Re-run in full on 2026-08-17, 76 commits later:
**every coordination row reproduced identically**; only the two wall-clock rows moved
(`claim_p50` 732 → 741, `claim_p95` 818 → 1013, both uncontended network latencies). The
comparison directory was deleted rather than kept, per this repository's one-results-directory
rule.

---

## Inspiration

Durable execution gives you exactly-once **inside** one workflow. It gives you nothing between two agents that don't know each other exists.

The concrete failure: two coding agents pick up overlapping tickets, both read `orders/repository.js`, both write it, last write wins. The field's answer is worktree isolation, which prevents collisions by making agents blind to each other and defers the problem to merge time.

We wanted the check _"is someone already doing this?"_ and the act _"I now own these files"_ to be **the same commit**. Split them across a vector database and a lock service and there is no application-level fix, because the two systems have no common commit point: you can pass a dedupe check against a stale index and then take a lease for work that is already finished.

## What it does

CORTEX is shared memory plus admission control for a fleet of coding agents working one repository.

Before an agent touches anything it calls `cortex_propose` with a plain-language statement and the resource keys it wants (`file:…`, `glob:…`). Inside **one SERIALIZABLE transaction**:

1. The statement is embedded (1024 dimensions) and searched against `intents` by cosine distance. A hit under \\( 0.39 \\) returns the earlier agent's **outcome**, not a rejection.
2. The intent is inserted, then every key is claimed with a single `INSERT … ON CONFLICT (repo_id, resource_key) DO UPDATE` guarded on `expires_at`. **All keys or none**, because a strict subset produces interleaved half-edits.
3. On partial acquisition it reads the holders _before_ rolling back, so a blocked agent learns who holds what, under which intent, until when — and re-plans instead of polling.

When an intent closes, a **changefeed** fires a sink that embeds the outcome and either reinforces the nearest existing finding within cosine \\( 0.2 \\) or inserts a new one. That is how one session's outcome becomes the next session's context, with no agent responsible for remembering.

Recall is one statement, and it is the thing a vector database cannot run:

```sql
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
)
SELECT n.fact, n.confidence, n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at) AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id AND i.repo_id = $2
WHERE n.dist < $4
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT $5
```

Semantic similarity joined to the episodic record of what happened the last time someone acted on those facts, ordered **reverts first, then distance**.

The three distance constants are ordered on purpose, and the ordering is the design:

$$d_{\text{consolidate}}\ (0.20)\ <\ d_{\text{dedupe}}\ (0.39)\ <\ d_{\text{recall}}\ (0.60)$$

Recall must be **looser** than dedupe, because a dedupe false positive cancels work that needed doing, while a recall false positive only spends attention.

## How we built it

Node and TypeScript, `pg` against CockroachDB Cloud (Basic tier, `aws-us-east-1`). One idempotent migration creates six memory tables plus a cost-control table:

```sql
CREATE TABLE findings (
  repo_id    UUID NOT NULL,
  fact       STRING NOT NULL,
  embedding  VECTOR(1024) NOT NULL,
  confidence FLOAT8 NOT NULL DEFAULT 0.5,
  VECTOR INDEX findings_semantic (repo_id, embedding vector_cosine_ops)
);
```

Embeddings come from Amazon Titan Text Embeddings V2 on Bedrock. The hosted demo is deployed with CDK: five Lambdas behind an HTTP API and a WebSocket API, S3 and CloudFront in front, every connection string a Secrets Manager dynamic reference.

Access control is three SQL principals with genuinely different grants, plus `FORCE ROW LEVEL SECURITY` on every table to confine the public demo's principal to its own sandbox scope. We verify privileges by **attempting the statement**, never by reading a catalogue, because `SHOW GRANTS` once answered a narrow question truthfully while three accounts held admin through a role membership.

671 tests across 42 files, all against the real cluster. Mocks and single-node stand-ins are disallowed.

## Challenges we ran into

- **The default vector opclass is `vector_l2_ops`, which serves `<->` and not `<=>`.** Every query in our memory model orders by cosine distance. With the default the queries returned _correct rows_ and full-scanned, so we would have shipped a submission claiming a vector index it was not using. Fixed to `vector_cosine_ops`.
- **The index prefix does not isolate tenants.** Omitting it does not fail closed; the planner falls back to a full scan and returns another repository's rows. A forgotten filter fails **open**. So every read carries `WHERE repo_id`, and the recall query carries it twice, because dropping the second one was measured ranking repo A's results on repo B's revert history.
- **Serialization retries that would not converge.** Once agents genuinely contended, both exhausted the five-attempt cap on roughly one run in twelve. The backoff base was 20ms against a transaction spending about a second in round trips, so colliding agents backed off by a third of the window they collided in. We raised the base to 250ms:

$$t_n = 250 \cdot 2^{\,n-1} + U(0,\ 250)\ \text{ms}$$

  Exhaustions went from 1/12 to 0/12 and retries settled at 1.
- **Phrasing decides whether a memory is reachable.** An abandonment note naming the _obstacle_ sits \\( 0.6725 \\)–\\( 0.7246 \\) from the task it exists to warn about; the restatement naming the _work_ sits \\( 0.4698 \\). Recall reaches \\( 0.60 \\), so the obvious phrasing produces memory nobody can find. We now embed a retrieval key distinct from the stored text.
- **A parameter that could not be one.** `SET cortex.demo_session = '<id>'` takes no bind parameter, and that id arrives from an anonymous browser. Interpolating it got a hostile session id to the parser attempting `DROP TABLE claims`. Replaced with `set_config($1, $2, true)`, which binds and ends at `COMMIT`, so a pooled connection cannot carry one visitor's scope into the next request.
- **A cost brake watching an empty meter.** Anthropic spend bills under `Claude Haiku 4.5 (Amazon Bedrock Edition)`, which Cost Explorer treats as a service distinct from `Amazon Bedrock`. The obvious budget filter would never have fired.

## Accomplishments that we're proud of

A published benchmark: five agents, thirty tasks, median of three runs per arm.

| metric | naive | cortex |
|---|---|---|
| duplicate_work_rate | 0.21 | **0.00** |
| lost_writes | 21 | **0** |
| conflicting_edits | 3 | **0** |
| wasted_tokens | 4000 | **867** |
| goodput (tasks/min) | 38.16 | **200.73** |

Model reasoning is replayed from committed cassettes, but **database behaviour is live in both arms**. The naive arm really loses writes; it is not scripted to.

**It reproduces.** Re-run in full 76 commits after publication: every coordination row above came back identical, and only the two wall-clock latency rows moved. The run records `liveCalls: {embed: 0, reason: 0}`, so nothing reached the network to produce them.

The limitations ship _with_ the table and are ours: small synthetic corpus, replayed reasoning, and a harness that serialises, so `serialization_retries` is **0 by construction** and claim latencies are uncontended. CORTEX recall returns nothing in that offline harness because it runs no changefeed, **which scores against us** on three tasks.

The dedupe threshold was the one number the benchmark recommended changing. We changed it from \\( 0.28 \\) to \\( 0.39 \\) as a separate act, published the sweep, and deliberately kept the offline judge at a **different** \\( 0.40 \\), so the mechanism and the thing scoring it cannot be tuned together.

And a live demo anyone can open with no account, key, cluster or card, running ten tickets through five agents twice against a real cluster.

## What we learned

A catalogue listing is not an entitlement and an `EXPLAIN` plan is not a guarantee. Invoke it, or write TBD. Three specification claims read as obviously true until we invoked them, and all three were false.

The most expensive bugs were the ones that **looked correct**: an index returning right answers by full-scanning, a privileges table that had been wrong for months because our tests asserted the reader's principal and merely called the writer's client "admin", and a deploy marker that made a stale bundle indistinguishable from a fresh one — which served our headline result inverted on the public URL for a day.

Reasoning caught none of them. Checking caught all of them.

## What's next for Cortex

`REGIONAL BY ROW` and a survival goal, deliberately **not** claimed here, because we ran single-region on Basic tier and describing a multi-region path we have not run would be exactly the inflation this write-up avoids.

Then: EventBridge between changefeed ingress and consolidation once reserved concurrency is available on the account; a real corpus with less engineered overlap; CI, which today is local and by hand because the suite needs live cluster credentials and about fifteen minutes; tracing beyond CloudWatch logs; wiring `ccloud cluster connection-string` into `cortex init` so onboarding needs no copy-paste; and the second attribution axis, since we can attribute a missing patch to an agent but not yet **which two correct changes compose wrongly**.
