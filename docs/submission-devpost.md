# U20 — Devpost submission

The three pieces `08` §5 asks for, plus the `02` §F walk that is this unit's done-when.

**How to use this file.** §1 is the Devpost description, written to be pasted. §2 and §3
are the B10 and B11 answer fields. §4 is B13, the optional feedback field. §5 is the `02`
§F checklist walked item by item. §6 is the rules diff. §7 lists every claim here that no
committed artifact backs, so nothing in §1–§4 has to be taken on trust.

**Two things about provenance, because they decide whether this file is usable.**

`07` §6 items 8 and 9 say to paste `02` §C and §D verbatim. **Do not.** §C's items 1, 3
and 4 describe the CockroachDB Cloud Managed MCP Server as the agent's read path, and V17
falsified that — the server executes as SQL user `managed-mcp`, which holds INSERT and
DELETE on `claims`, and the route was dropped in favour of `cortex_reader` with a SQL
grant. §C item 3 also describes `cortex init` provisioning a cluster through the ccloud
CLI; that command is U2 and is **not built**. §D lists Amazon EventBridge and AWS Budgets;
neither is deployed. B10 and B11 ask what was actually done, so §2 and §3 below are written
from the repository as it stands and replace §C and §D for submission purposes. `02` itself
is not edited by this unit.

Every number below comes from `bench/results/2026-08-12T18-35-38-014Z/summary.md` or from a
named entry in `docs/verification-log.md`. **Nothing here claims LIVE model reasoning in the
demo, which is not built** — U24 owns it, the counter table and the measured rate exist, and
no route calls them.

**Revised 2026-08-16.** This file was first drafted on 2026-08-13, when the ten-ticket
two-arm fleet workload was designed and unbuilt, and it said so. That is no longer true:
U21, U22 and U23 closed on 2026-08-13 (`npm run gate:workload` 20/20, `npm run gate:async`
13/13 against the deployed stack), and the rebuilt judge page was deployed on 2026-08-16
(V56). Left alone, this description would have *understated* the submission — which is the
same class of error as overstating it, and the reason the draft is re-derived from
`docs/UNITS.md` rather than trusted.

---

## 1. Devpost description

*(Paste from the rule below to the rule above §2. Structure follows `07` §6.)*

---

# CORTEX — shared, arbitrated memory for fleets of coding agents

**Durable execution gives you exactly-once within one workflow. It does not give you
mutual exclusion between agents that do not know each other exists. CORTEX puts the
semantic dedupe check and the right to act in one SERIALIZABLE transaction, on one
snapshot, in CockroachDB.**

## The benchmark

Five agents, thirty tasks, one repository, run three times per arm. Median. Same tasks,
same seeded order, same simulated clock, same recorded reasoning, same recorded
embeddings. The only difference between the arms is where the shared state lives.

| metric                | naive | cortex |
|-----------------------|-------|--------|
| duplicate_work_rate   |  0.21 |   0.00 |
| lost_writes           |    21 |      0 |
| conflicting_edits     |     3 |      0 |
| wasted_tokens         |  4000 |    867 |
| goodput (tasks/min)   | 38.16 | 200.73 |
| claim_p50 (ms)        |     — |    732 |
| claim_p95 (ms)        |     — |    818 |
| serialization_retries |     — |      0 |

`—` means the arm has no such thing to measure. Model reasoning is replayed from committed
cassettes; **database behaviour is live in both arms** — the naive arm really does lose
writes, and is not scripted to.

**The limitations belong with the table and are not decoration.** All of them are the
author's, published in `bench/results/<run>/summary.md`:

- **Small synthetic corpus.** 40 fixture files, 30 tasks, one workload shape. Overlap was
  chosen so the failure modes appear at all; a repository with less overlap shows less
  difference.
- **Replayed reasoning.** The agents do not think during a run.
- **The harness serialises,** one step at a time, so the run reproduces. Two transactions
  never overlap, which means `serialization_retries` is **0 by construction** and the claim
  latencies are **uncontended**. The real race is evidenced separately, by
  `npm run gate:contend` and by `test/retry.test.ts`.
- **CORTEX recall returns nothing in this harness, and that understates CORTEX.** `findings`
  is populated by changefeed-driven consolidation; this offline harness runs no changefeed,
  so the table stays empty and every recall returns 0 rows, while the naive arm reads its
  own local note store and gets real hits. On the three recall-dependent tasks the
  benchmark scores against us.
- **`goodput` is per simulated minute,** not wall-clock. Wall clock would compare a local
  file write against a cloud round trip and call the difference a coordination result.
- Single region, single cluster tier (CockroachDB Cloud **Basic**).

**The dedupe threshold was the one number this benchmark recommended changing, and it was
changed — disclosed rather than hidden.** It shipped at 0.28 through the day-two gate,
where the CORTEX row was 0.08 rather than 0.00. A published sweep put the perfect band at
(0.3630, 0.4293); the constant was closed at **0.39** afterwards, as a separate act, and
the benchmark re-run. The sweep, the old value, the new value and the fact that one
followed the other are all committed in the same results directory. The offline judge
scores at 0.40 and is deliberately a *different* number, so the mechanism and the thing
that scores it cannot be tuned together.

## How to try it

**Demo:** https://d11xbslgdgomdp.cloudfront.net — no account, no API key, no cluster, no
card, nothing to install. One click runs **ten tickets through five agents, twice** — once
under CORTEX's arbitration and once under worktree isolation, the thing the field actually
ships — against a real CockroachDB Cloud cluster. Both lanes stream their agents' steps as
they happen, and both finish by loading their final file trees into sandboxed frames, so
you click through two running applications rather than reading a claim about them. On the
run behind this submission the arbitrated lane lost **0** writes and had **0** file
collisions; the isolated lane lost **2**, collided **3** times, repeated one semantic
duplicate and walked one extra dead end. Every one of those numbers comes from the run you
just watched, not from this page — **so your run may not match ours exactly.** The isolated
lane's failures are races, and a race that lands differently loses a different amount. The
direction is what reproduces; the digits are what the run reports.

The patch bodies each agent applies are committed to the repository and reviewable — **no
model wrote the code**, and the page says so. What is live is the coordination: the
embeddings, the dedupe search, the claim, the race decided by a unique index, the
changefeed, and the losses.

**Run it on your own repository:** that is the CLI, and *there* you bring your own cluster
and your own credentials — which is correct for a tool that writes to your codebase, and is
a different thing from the demo. The hosted demo never accepts a credential from a browser
under any name, on any path, behind any panel. There is no such field, and a test asserts
its absence against the page source and the deployed API.

## What it is

CORTEX is a shared memory layer for fleets of coding agents working on one repository. It
gives every agent one durable brain: what has been learned about this codebase, what is
being attempted right now, and what was tried before and failed. Every write to that brain
is arbitrated inside a single SERIALIZABLE transaction, so two agents cannot act on
contradictory beliefs and cannot redo each other's work.

It is **not** a lock service, not an orchestrator, and not another agent framework. It sits
underneath whatever agents you already run, and an unmodified third-party agent reaches it
over MCP and over plain SQL with no bespoke client code.

## The four memory tiers, and the database primitive under each

| Tier | What it holds | CockroachDB primitive |
| --- | --- | --- |
| **Working** | who holds which resource, right now | `claims` — unique index as the arbiter, **row-level TTL** so a dead agent's claims expire without a supervisor |
| **Episodic** | what was attempted, by whom, how it ended | `intents` — status lifecycle, outcome JSONB, `action_ledger` for exactly-once closes |
| **Semantic** | what is known about this codebase | `findings` — `VECTOR INDEX (repo_id, embedding)` with `vector_cosine_ops` |
| **Procedural** | the sequence of memory actions, replayable | `action_ledger`, streamed to the browser by a **changefeed** |

## The one query a vector database cannot run

This is the recall query, shipped byte-for-byte in the published Agent Skill and pinned by
a test to the query the implementation issues:

```sql
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, contradictions,
         embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
)
SELECT n.fact,
       n.confidence,
       n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at)                                             AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id AND i.repo_id = $2
WHERE n.dist < $4
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT $5
```

It joins semantic similarity to structural outcome history and orders by *how often this
was reverted* ahead of *how close it is*. A vector store cannot run it because it does not
hold the outcome history; a relational store cannot run it because it does not hold the
vectors. Both `repo_id` predicates are load-bearing and separately asserted — dropping the
one on the join was measured returning another tenant's revert history (V14).

## Architecture

*(Diagram: `docs/architecture.md`. It must show the read plane as `cortex_reader`; the
managed MCP server is not the route.)*

Everything is on AWS and in one CockroachDB Cloud cluster. Agents read as a `SELECT`-only
SQL role over an ordinary Postgres driver. Agents write **only** through three typed MCP
tools, which is what makes arbitration unavoidable rather than advisory. A changefeed on
the memory tables carries committed rows to a Lambda, which consolidates a closed intent
into a durable finding and fans the row out to browsers over a WebSocket.

## CockroachDB tools, and what the agent actually did with them

*(§2 of this file — paste it here.)*

## AWS services, and how

*(§3 of this file — paste it here.)*

## Production readiness

**Three privilege planes, each verified by attempting the statement rather than by reading
a catalogue.**

| Plane | Principal | Proved by |
| --- | --- | --- |
| Read | `cortex_reader` | nine attempted writes — an INSERT on each of the six tables plus an UPDATE, a DELETE and a DROP — all refused with SQLSTATE **42501** |
| Write | `cortex_writer` | proved to authenticate, then refused `DROP TABLE`, `ALTER TABLE … ADD COLUMN` and `CREATE INDEX`, each with **42501**, with the `findings` row count identical before and after |
| Demo | `cortex_demo` | confined by row-level security to one unexpired demo scope; every statement outside it attempted and refused |

We do not check this with `SHOW GRANTS`. Early in the project all three service accounts
turned out to be members of `admin` through a role membership the catalogue query never
asked about, and `SHOW GRANTS` answered truthfully the whole time (V9). Since then the only
accepted evidence is the statement being refused.

**The demo's principal is confined by row-level security, not by a WHERE clause.** All six
memory tables carry `FORCE ROW LEVEL SECURITY` with a policy admitting only rows belonging
to an unexpired demo scope **and** to the scope named on that connection. The scope binds
as a **bind parameter** via `set_config(..., is_local => true)`, not as `SET` — `SET` takes
no parameter, and restoring it put a hostile session id into the parser attempting
`DROP TABLE claims`, stopped only by the grant. `is_local` also ends the scope at `COMMIT`,
so a pooled connection cannot carry one visitor's scope into the next request.

**No agent-reachable path accepts SQL, a table name, or any structural parameter.** The MCP
schemas are closed — an undeclared argument is rejected at the boundary — and a test drives
`{"sql": "DROP TABLE claims"}` at `cortex_propose` over the wire to prove it.

**Failure modes are built and forced, not described.**

- **Degraded embeddings.** `npm run gate:degrade` refuses every Bedrock embedding call with
  a 429. All four demo beats still run, 51 statements still reach the driver, every affected
  intent is marked in the database, and dedupe is **skipped rather than run at a threshold
  of zero** — the show-SQL transcript contains no similarity search at all, because the
  panel must not show a search the system says did not happen. The mark is a column, not a
  response field: a hash vector left in the candidate set corrupts every later dedupe
  decision, long after Bedrock recovers, so `findDuplicate` carries `AND NOT
  embedding_degraded`.
- **Serialization conflicts.** Every write path goes through one 40001 retry helper, five
  attempts with exponential backoff and jitter. The base delay was raised 20ms → 250ms after
  measurement: at 20ms two colliding agents backed off by a third of the window they
  collided in and restarted into each other, exhausting the cap on one run in twelve; at
  250ms that is zero in twelve and the modal retry count is 1.
- **Exhausted retries.** An agent that loses five times re-plans once, visibly. It is
  reported as contended and never as an exception, because the demo may not present an error
  page.
- **LIVE cost.** A global run counter lives in the cluster and is checked and incremented in
  the same transaction as the run it authorises. The Bedrock rate is measured from this
  account's own billing rather than from a pricing page: **$3.30 per 1M input tokens and
  $16.50 per 1M output**, billed under `Claude Sonnet 4.5 (Amazon Bedrock Edition)`, a
  service distinct from `Amazon Bedrock`.

**Observability:** every demo run's statements are recorded by a wrapper around the live
client, so a statement can reach the "show SQL" panel only by having gone to the driver.
The panel is a transcript, not an illustration. It is grouped by transaction, so you can
read invariant 1 straight off the screen: one `BEGIN` containing both the dedupe search and
the claim insert.

## Prior art, and how this differs

| Category | Representative | What it solves | What it leaves open |
| --- | --- | --- | --- |
| Durable execution | Temporal, Restate, Inngest, DBOS, Cloudflare Workflows | exactly-once and crash resume **within one workflow** | mutual exclusion **across** independently spawned agents |
| Graph-state frameworks | LangGraph | races inside one graph, via reducers | agents not in one graph, that do not know each other |
| Agent memory layers | Mem0, Zep, Memori, Letta | semantic recall across sessions | memory writes are not decisions; no arbitration |
| Unified-substrate marketing | Tacnode, MongoDB, Oracle | states the thesis | no falsifiable proof harness |

**The gap we occupy:** nothing we found arbitrates *side-effecting actions* between
concurrently running LLM agents using database-level SERIALIZABLE leases co-located with
the semantic memory, and nothing ships a reproducible harness that measures what breaks
without it.

## Limitations, stated by the author

1. **The benchmark's limitations above are the real ones** and they are repeated here
   rather than buried: synthetic corpus, replayed reasoning, a serialised harness that
   makes two of its own metrics harness-properties, and a recall path the harness cannot
   exercise at all.
2. **The hosted demo runs a real ten-ticket two-arm workload, and its patch bodies are
   authored.** Five agents per arm work eleven tickets against a fourteen-file corpus; the
   coordination is entirely live — real transactions, real embeddings, a race decided by the
   unique index, a real changefeed — and the four beats are *observed* rather than scripted.
   What is fixed is the code each agent applies: every ticket carries a small checked-in
   patch, so an agent reads the real file, decides, claims through the one arbitration
   transaction, applies and closes. **No model wrote the committed code, and the page says
   so.** The naive lane is worktree isolation with clean merges — what the field actually
   ships — not a strawman.
3. **The demo performs no model reasoning.** Its embeddings are live Bedrock calls and its
   database behaviour is fully live, and the page says exactly that. LIVE reasoning is
   specified, budgeted and metered but **not built**, so there is currently one mode.
4. **The demo's naive arm and the benchmark's naive arm are different things.** The
   benchmark's writes a JSON file with last-write-wins; the demo's does the same thing to a
   JSONB cell, because an arm that touches no database executes no statements and so cannot
   demonstrate losing a write. The numbers are not comparable across the two.
5. **This account's Lambda concurrency limit is 10, not the AWS default of 1000,** and it
   cannot be raised from the CLI or subdivided. Ten simultaneous visitors can reach a 503.
   It is an account restriction, we have measured it, and the mitigation is to build for 10.
6. **Reserved concurrency is unavailable on this account at any value,** so one of the three
   designed cost brakes is falsified rather than implemented.
7. **Expired demo rows become unreachable but are not reclaimed.** Expiry is enforced in the
   policy predicate at read time, so a scope goes dark the instant it passes; nothing then
   deletes the rows. A blanket TTL would reach real memory, so the fix is a schema decision
   and is recorded rather than guessed at.
8. **Single tenant, single region, one cluster tier.** Multi-region is out of scope on the
   free tier — describing `REGIONAL BY ROW` we have not run would be a claim we cannot make.

## Feedback on the CockroachDB AI tools

*(§4 of this file — paste it into the optional feedback field.)*

---

## 2. B10 — which CockroachDB tools were used, and what the agent actually did with them

*(This replaces `02` §C. See the note at the top of this file.)*

The rules list four tools and require at least two. **We used two of the four in the
finished system, evaluated the third and rejected it on a measurement, and did not use the
fourth.** Saying which is which is more useful to a judge than claiming four.

### 1. CockroachDB Distributed Vector Indexing — used, and it is the mechanism

`VECTOR INDEX (repo_id, embedding)` on both `intents` and `findings`. The prefix column
partitions the index per repository, so a nearest-neighbour search is bounded to one
codebase at the index level. Every agent action embeds its intent (Amazon Titan Text
Embeddings V2, 1024 dimensions) and runs a similarity search against in-flight and closed
intents **inside the same transaction that acquires the right to act**. That co-location is
the entire thesis: with a separate vector store and a separate lock service you can pass a
dedupe check against a stale index and then take a lease for work that is already done, and
there is no application-level fix because the two systems have no common commit point.

Two things we learned by invoking rather than reading, both of which changed the schema:

- **The default opclass is `vector_l2_ops`, which serves `<->` and not `<=>`.** Every query
  in our memory model orders by cosine distance. With the default opclass the queries still
  returned *correct rows* — and full-scanned. We would have shipped a submission claiming a
  vector index it was not using. Fixed to `vector_cosine_ops`; the plan then reads
  `vector search … prefix spans: [/'<repo>' - /'<repo>']`.
- **The index prefix does not isolate tenants on its own.** Omitting the prefix does not
  return nothing; it falls back to a full scan and returns another repository's rows. A
  forgotten filter fails *open*. So every read carries `WHERE repo_id`, that is one of the
  eight invariants, and the recall query carries the predicate **twice** — once in the CTE
  and once on the join — because dropping the second one was measured ranking repo A's
  recall on repo B's revert history.

### 2. CockroachDB Agent Skills — used, in the publishing direction

CORTEX ships its own skill, `skills/cortex-memory/SKILL.md`. It carries the exact recall
SQL, the rule for when an agent must declare an intent before touching a resource, and how
to obtain the query's first parameter — the model id and width to embed with, because a
distance query against vectors from a different model or width is meaningless.

**What that buys: an unmodified agent recalls with no bespoke client code at all.** The
skill's SQL is pinned byte-for-byte to the implementation's, and a test lifts the query out
of the published markdown at run time and runs it through a stock Postgres driver as
`cortex_reader`. Editing the query in either place fails the test. Both `repo_id`
predicates are asserted *separately*, because a byte-for-byte equality alone would still
pass if someone edited both files together — which is the exact way that predicate went
missing once.

The skill also publishes the recall distance threshold, and a test asserts it equals the
constant in the source, because the SQL is parameterised and the byte-for-byte pin cannot
see that particular drift.

### 3. CockroachDB Cloud Managed MCP Server — evaluated, measured, and deliberately not the read path

This is the most useful thing we have to report, so it is reported rather than omitted.

The original architecture routed every agent read through the managed MCP server, on the
argument that read access would then be governed by Cloud RBAC and audit logging rather
than by code we wrote. We measured it instead of assuming it.

- The server publishes twelve tools, of which three write: `insert_rows`, `create_table`,
  `create_database`. Being read-only cannot be a property of that endpoint; it would have to
  come from the principal.
- At **Cluster Developer** the Cloud metadata tools work and *every* SQL-shaped tool is
  refused identically — including the write. That is not evidence the read path is safe; it
  is evidence nothing is authorised.
- At **Cluster Operator** the SQL tools come alive, and the server executes as SQL user
  `managed-mcp`. `select_query` returns `{"who":"managed-mcp"}`. An `insert_rows` call
  against `claims` came back with SQLSTATE **23502** — a NOT NULL violation — and not
  **42501**. The privilege check ran *ahead* of the constraint and passed. That principal
  holds INSERT and DELETE on `claims` and INSERT on `intents`.

An agent handed that endpoint for recall would also hold an unarbitrated write path into
the two tables arbitration exists to protect. Every invariant would be *bypassed* rather
than broken, because the agent would never call `cortex_propose` at all. We dropped the
route rather than try to constrain its principal, and the read plane is now a SQL grant we
can test by attempting writes against it. That is a stronger claim than the one we started
with, and a judge can run it.

### 4. ccloud CLI (Agent-Ready) — not used

The one-command provisioning CLI (`cortex init`) is designed and is not built. It is
deliberately not claimed. The cluster was provisioned by hand; every migration applies
idempotently through a script in the repository, and the schema re-applies cleanly twice in
a row.

### Beyond the tool list, because B10 asks what the agent did

Four CockroachDB capabilities outside the four-tool list are load-bearing and each was
verified against the live cluster before anything was built on it:

- **SERIALIZABLE + the unique index as the arbiter.** All-or-nothing multi-key claims; a
  blocked agent learns the holder, the holder's intent id, and the lease expiry, so it can
  re-plan instead of polling. Two processes in two terminals contend for one key on a shared
  start instant, one wins, the loser prints the winner's identity — and the winner alternates
  between runs, so it is a real race and not an ordering.
- **Changefeeds with a webhook sink**, on the free tier. A row committed as `cortex_demo`
  reaches an anonymous browser's WebSocket in ~126ms, taken end to end from the hosted API.
- **Row-level TTL on `claims`.** A dead agent's claims expire on their own; there is no
  supervisor. Measured sweep lag is 62–221 seconds, which is why the claim insert is
  `ON CONFLICT DO UPDATE` guarded on `expires_at` rather than `DO NOTHING`.
- **Row-level security with `FORCE`,** which is what confines the public demo's principal to
  its own sandbox scope.

---

## 3. B11 — which AWS services were used, and how

*(This replaces `02` §D, which lists two services that are not deployed. See the note at
the top of this file.)*

| Service | Load-bearing function |
| --- | --- |
| **Amazon Bedrock** | Amazon Titan Text Embeddings V2 at 1024 dimensions embeds **every** intent and finding — live calls in the hosted demo, not cassettes. Claude Sonnet 4.5 via the Converse API is the agent reasoner in the benchmark harness; its outputs are recorded once and replayed so the published run reproduces. |
| **AWS Lambda** | Four functions, and they are the whole hosted surface: the identity probe, the demo API (arbitration, recall, consolidation, the SQL log), the changefeed sink, and WebSocket connect/disconnect. |
| **Amazon API Gateway** | HTTP API for the demo routes, WebSocket API for the live memory stream, and the **ingress for CockroachDB's own changefeed webhook sink** — the database calls back into the application over it. |
| **Amazon DynamoDB** | The WebSocket connection registry (so a changefeed row can be fanned out to every live browser) and the per-session SQL transcript the "show SQL" panel reads. |
| **Amazon S3 + Amazon CloudFront** | Origin and distribution for the demo SPA. Anonymous, no login, no key. |
| **AWS Secrets Manager** | Every database connection string is a `{{resolve:secretsmanager:...}}` dynamic reference resolved by CloudFormation at deploy time, never a template value. This is not decoration: the first arrangement satisfied the "no credential in the repository" rule as written and left the credential in the synthesized template and in CloudFormation's stored copy. It was found by grepping the build artifact, not by reasoning about the rule. |
| **Amazon CloudWatch** | Structured logs for all four functions; the changefeed sink logs a consolidation failure and answers 200 anyway, so a stalled feed degrades to a staleness badge rather than blocking an agent. |

**Two services the design calls for and the deployment does not have, stated plainly rather
than listed:**

- **Amazon EventBridge** was specified between the changefeed ingress and consolidation.
  The sink consolidates inline instead. What the bus would add over what exists is a
  *separate concurrency pool* for the two consumers — and on an account where reserved
  concurrency cannot be set at any value, there is no pool to separate. It would have added
  a hop and a failure mode for no behaviour this deployment can express.
- **AWS Budgets** is the third designed cost brake and is not built, because LIVE reasoning
  is not built and there is nothing yet to meter. One finding is worth publishing anyway: a
  Budget filtered on the `Amazon Bedrock` service would **never fire**, because Anthropic
  model spend on this account bills under `Claude Sonnet 4.5 (Amazon Bedrock Edition)`, a
  separate top-level service. `Amazon Bedrock` on the same days carries only the Titan
  embedding line.

Six services deployed, each with one clear job. We did not add a seventh for appearance —
the rule that requires meaningful integration cuts against sprinkling exactly as hard as it
cuts against omitting.

---

## 4. B13 — feedback on the CockroachDB AI tools

*(Optional field. `docs/verification-log.md` is the long version of this; every item below
has an entry there with the actual output.)*

We kept a verification log from the first day: what was checked against the live cluster,
what it returned, and what we did when it disagreed with the documentation. It has 49
entries. Four spec claims we wrote ourselves were falsified by invoking them, and each read
as obviously true until it was invoked. This is the feedback that came out of it, roughly
in order of how much time each cost.

**1. The Managed MCP Server's SQL principal is not documented, and it is not read-only.**
This is the biggest one. The server publishes `insert_rows`, `create_table` and
`create_database`, so read-only cannot be a property of the endpoint — it has to come from
the principal. We could not find documentation saying which SQL identity the server executes
as, and Cloud roles and SQL roles are managed independently, so `GRANT` does not reach it.
Measured: it executes as `managed-mcp`, and an `insert_rows` against `claims` returns
**23502** — a constraint violation, not **42501**. The privilege check passed. That means
any agent given the server for *recall* also holds an unarbitrated write path.

The role escalation is also invisible from the outside. At Cluster Developer, `list_clusters`
and `get_cluster` work and every SQL tool answers `unauthorized` — including the write, which
looks reassuring and is not. At Cluster Operator, reads and writes come on **together**;
nothing in the server's design separates them.

*What would fix it:* let the managed server's SQL identity be pinned to a named SQL user, or
publish a read-only tool subset. Either would let a team hand an agent Cloud-governed reads
without also handing it INSERT on the tables it is meant to be arbitrating. Today the safe
answer is a `SELECT`-only SQL role and a plain Postgres driver, which is what we shipped —
and we would rather have used your server. Second, please document the SQL identity and the
role→tool mapping; we spent three verification rounds discovering it by escalating a service
account one role at a time.

**2. Cloud roles are assigned in the Console, and the FAQ we followed implied otherwise.**
We read the service-account documentation as saying role assignment was available through
the API and lost time before finding it is a Console action. Worth one sentence in the docs.

**3. The default vector index opclass is `vector_l2_ops`, and the failure is silent.** Our
schema asked for cosine (`<=>`) against the default index. The queries returned **correct
rows** and full-scanned — which on a demo-sized corpus looks instant. Four EXPLAINs isolate
it: `<->` on an L2 index uses the vector search at both 4 and 2000 rows; `<=>` on the same
index full-scans at 2000; `<=>` on `vector_cosine_ops` uses it. Row count was never the
factor. **We would have shipped a submission claiming a vector index it was not using.**
A hint in `EXPLAIN`, or a notice on `CREATE INDEX` when a table's queries use an operator
the opclass does not serve, would catch this class of error for everybody. It is the single
highest-value diagnostic you could add for this hackathon's cohort specifically.

**4. The prefix column bounds the search when supplied and fails open when not.** We
believed, and had written into our own design, that isolation "lives in the index" — that a
query without the prefix would return nothing. It full-scans and returns other tenants'
rows. That is the right engineering choice and it is the opposite of what a reader assumes
from "partitioned per tenant". Documenting the failure mode explicitly — *a missing prefix
predicate degrades to a full scan across all prefixes* — would prevent a whole category of
tenancy bug in exactly the applications this vector index is being marketed for.

**5. Row-level security on Basic works, with two undocumented edges that both cost us
time.**

- **Policy expressions cannot contain a subquery.** `EXISTS (SELECT … FROM repos …)` fails
  with 42P01 and `IN (SELECT …)` with 42703 — two different errors for the same underlying
  restriction, neither of which says "subqueries are not permitted here". The way through is
  a `STABLE` function. Not `LEAKPROOF`: this cluster requires leakproof functions to be
  `IMMUTABLE`, which a policy predicate reading session state cannot be.
- **`CREATE POLICY IF NOT EXISTS` silently skips when the name exists.** Our migration
  applied cleanly to a fresh cluster and did nothing to the live one — it reported success
  while the cluster kept the old predicate. We now DROP-then-CREATE every policy. A notice on
  the skip would have turned a silent divergence into a one-line fix.

Positive, and worth saying: RLS with `FORCE` is the reason a public anonymous demo can write
to the same cluster that holds real memory. `GRANT` alone could not have given us
*unreachability*, only filtering. It is the feature that made the hosted demo possible.

**6. `SET` takes no bind parameter, and the obvious workaround is an injection.** To scope a
connection to a demo session we needed a per-request setting. `SET cortex.demo_session = $1`
is not valid, and interpolating the value put a hostile session id straight into the parser,
attempting `DROP TABLE claims` — stopped only by the grant. `SELECT set_config('…', $1,
true)` is the answer, it binds properly, and `is_local => true` ends the scope at `COMMIT`
so a pooled connection cannot leak one visitor's scope into the next request. This deserves
to be in the RLS documentation next to the session-variable pattern, because the natural
first implementation is the unsafe one.

**7. Changefeeds to a webhook sink work on Basic, and are the best part of the platform for
this use case.** A row committed by a least-privileged principal reaches an anonymous
browser's WebSocket in ~126ms, end to end, through a Lambda. It let us build memory
consolidation entirely off the agent's critical path with no queue, no bus and no polling.
One operational note that cost us a debugging session: creating a second feed over the same
tables to the same sink **doubles every event** downstream rather than being rejected or
deduplicated, so our tooling now cancels existing feeds before creating one. A warning when
a new feed overlaps an existing feed's table set and sink URI would help.

**8. Row-level TTL is the right primitive for agent leases, and its sweep lag is the thing
to document.** "A dead agent's claims expire on their own, with no supervisor" is exactly
what we wanted. Measured sweep lag was 62–221 seconds, which is fine — but it means expiry
is not a read-time guarantee, so our claim insert is `ON CONFLICT DO UPDATE` guarded on
`expires_at` rather than `DO NOTHING`. Anyone building leases on row-level TTL needs to know
that before they design the insert, not after.

**9. Basic tier's real limit is burst throughput, not the Request Unit budget, and neither is
visible from the API.** After two weeks of benchmarks, sweeps, gates, a deployed demo and
four full test-suite runs in one morning we had used **2.81M of 60M Request Units — 4.7%**.
So the RU ceiling was never close. What *is* exhaustible is burst throughput: the same
600-second test suite on the same tree took 2504 seconds on the third back-to-back run of one
day and hung outright on the fourth, then was completely normal after a rest. That is
correct behaviour for the tier and we are not complaining about it — the problem is that it
is **invisible**. The RU figure is Console-only; `/usage`, `/metrics`, `/usagelimits` and
`/costs` are all 404 on the Cloud API. A throttling signal in `SHOW` output, or an RU/burst
endpoint on the Cloud API, would have turned a day of "is our code slow now?" into a glance.
A saturated cluster is indistinguishable from a regression when you cannot see the meter.

**10. The platform hands out `admin` by default, and the catalogue tells the truth about
it.** All three of our purpose-built service accounts turned out to be members of `admin`.
`SHOW GRANTS` answered our question accurately every time — we were asking the wrong
question. This is not a bug, but it is a documentation opportunity: a "verify least
privilege by attempting the statement, not by reading the catalogue" note in the service
account docs would be worth more than a paragraph on `GRANT` syntax. It is now the only kind
of evidence we accept in this project, and it caught a second, different privilege error
five days later.

**11. Cluster settings on Basic were more permissive than we expected, in a good way.**
`SET CLUSTER SETTING feature.vector_index.enabled` is permitted for an ordinary cluster
admin on the free tier, so the migration was not blocked. Several things we had budgeted
fallbacks for — vector indexes, changefeeds to a webhook, row-level TTL, historical queries,
RLS — all worked on Basic on the first attempt. The free tier is genuinely capable of the
whole architecture, and that is worth advertising more loudly than it currently is.

**12. Two AWS-side findings that are not yours but affect this cohort.** Reserved concurrency
cannot be set at any value on an account whose total concurrency is 10, so a common
cost-control pattern is unavailable to hackathon accounts. And Anthropic model spend bills
under a separate service name from `Amazon Bedrock`, so the obvious Budget filter watches an
empty meter. Both are worth a line in your AWS integration guide.

---

## 5. `02` §F — pre-submission checklist, walked

Walked 2026-08-13. §F is dated 2026-08-17; this is the dry run, and every row marked
**BLOCKED** or **ACT** needs re-walking on the day.

| # | Item | Verdict | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Rules page re-fetched and diffed | **READY** | Done in §6 below, 2026-08-13. **No change detected.** Re-fetch on 2026-08-17 per §E WATCH-5. |
| 2 | Repository public, MIT licence visible in About | **BLOCKED** | `gh repo view` reports `"visibility":"PRIVATE"` and `"licenseInfo":null`. A `LICENSE` file landed in the working tree during this unit (U18) and is **uncommitted**, so GitHub has never seen it. Two acts remain: commit it, and flip the repository to public in settings — B2 wants the licence **detectable in the About section**, which is a settings act as well as a file. The licence is **MIT** — Julian's call on 2026-08-13, settling a three-way disagreement in which `LICENSE` and `package.json` said ISC while `02` B2, `spec/09` §1 and the rules' own recommendation said MIT. `LICENSE`, the `package.json` `license` field, `README.md` and `docs/third-party.md` now all say MIT. |
| 3 | README has setup, run instructions, prior-work disclosure, third-party licences | **READY** | `README.md` and `docs/third-party.md` are committed (U18, 2026-08-16). The first screen carries the two-metric table, the demo URL and the try-it / run-it split; prior work is disclosed under A9; third-party licences are enumerated with their tallies and the regeneration commands. Row 16 — the clean-clone reproduction the README documents — now passes. |
| 4 | Demo URL loads anonymously, no key, no login | **READY, pending Julian's own act** | The CloudFront page was fetched anonymously on 2026-08-13 and serves the three panels, the run button, the arm toggle and the show-SQL control. §F's full form is a **private window on a machine that never touched this project**, which is Julian's act and not a script's. |
| 5 | No credential input field anywhere in the demo UI | **READY** | Three layers. A test scans the page source for any input, form or credential-shaped name including commented out; the rendered DOM was driven in a browser and has three buttons and zero inputs; and the deployed API refuses a credential-shaped field in the body **and** on the query string with `400 {"field":"query.dsn"}`, proved by the same `curl` returning 404 before the fix and 400 after. Re-drive the DOM after any deploy. |
| 6 | All four degradation rungs exercised by forcing the limit | **BLOCKED — 1 of 4** | Rung 2 (embeddings throttled) is built and forced: `npm run gate:degrade`, 7/7. Rung 1 (LIVE quota exhausted → REPLAY) needs LIVE reasoning, which is not built. Rung 3 (per-session row cap) is deferred to the unit that owns the state route. Rung 4 (cluster unreachable → pre-recorded walkthrough behind a banner) is not built. **This row cannot go green before those units land, and the Devpost description in §1 does not claim it.** |
| 7 | Each of the three cost brakes fired deliberately, demo stayed reachable | **BLOCKED — 1 of 3, and one is falsified** | Brake 2 (global run counter, `LIVE_RUNS_PER_DAY = 10`) is built and its privilege confinement is asserted by attempting the refusals; it has never been *fired*, because no route calls it yet. Brake 1 (reserved concurrency of 2) is **falsified on this account at any value** and nothing was substituted. Brake 3 (Budget alarm) is not built, and carries the finding that it must filter on `Claude Sonnet 4.5 (Amazon Bedrock Edition)` or it will watch an empty meter. |
| 8 | README and Devpost both state the zero-setup promise, and that BYO-credentials is CLI-only | **PARTIAL** | §1's "How to try it" says both, in the same breath, deliberately. The README's first screen makes the same split; it is uncommitted, so the row closes when U18's work is committed. |
| 9 | Weekly anonymous reachability check scheduled through 2026-09-15 | **ACT — not scheduled** | Nothing schedules it. §E WATCH-4 is explicit that checking the cluster is unpaused is **not** the same test and will not catch a broken deploy, an expired certificate, or a guardrail that fired and never reset. The check is: open the demo URL in a private window on a machine that has never touched this project and run a scenario end to end. |
| 10 | LIVE mode works and its daily cap degrades gracefully to REPLAY | **BLOCKED** | LIVE reasoning is not built. The counter table, its atomic check-and-increment and the measured Bedrock rate exist; nothing calls them. §1 states this as a limitation rather than working around it. |
| 11 | Video under 3:00, public, English, shows terminal and memory layer, no third-party marks | **BLOCKED** | Not recorded. **One constraint this walk adds:** `07` §4 and §5 say the video is recorded in LIVE mode. LIVE reasoning does not exist, so that instruction cannot be followed as written, and narrating the demo as live *inference* would breach A7. What the footage can honestly show is live database behaviour and live embeddings — which is what the deployed page itself says. |
| 12 | Devpost description contains the benchmark table and the architecture diagram | **PARTIAL** | Table: **ready**, §1, quoted from the committed results directory with its limitations attached. Diagram: `docs/architecture.md` is committed and its Mermaid source shows the read plane as `cortex_reader`. **What remains is presentational** — §1 still carries a pointer, and Devpost renders no Mermaid, so the diagram must be exported to an image and attached before the description is pasted. |
| 13 | B10 and B11 answers pasted from sections C and D | **READY, with a deliberate deviation** | **Do not paste §C and §D.** §C describes an abandoned read path and an unbuilt CLI; §D lists two services that are not deployed. §2 and §3 of this file are the answers, rewritten from the repository. This row's wording in `02` §F is now wrong and should be re-pointed when §C and §D are corrected. |
| 14 | Optional feedback field completed in detail | **READY** | §4, twelve items, each traceable to a verification-log entry with real output. |
| 15 | AWS Budget alarm active; cluster not near free-tier limits | **PARTIAL** | Budget: **not built** (row 7). Cluster: **healthy** — 2.81M of 60M Request Units, 4.7%, read from the Console after two weeks of heavy use. The reading is Console-only; the Cloud API returns 404 for every usage endpoint. What is exhaustible is burst throughput, which refills with rest. |
| 16 | Benchmark results reproduce from a clean clone | **READY** | **Done, V57, 2026-08-16.** Clone to an empty directory, `npm ci`, `npx tsc --noEmit` clean, `npm run bench:results`: every coordination row identical to the published table, only `claim_p50` (732 → 778) and `claim_p95` (818 → 967) moved, both arms recording `mode=replay` and `liveCalls: {embed: 0, reason: 0}`. It also found a reproduction blocker — the committed recipe named `CORTEX_DSN` where the CORTEX arm runs on `CORTEX_WRITER_DSN` — now corrected in place with no published number moved. **Caveat:** the clone was taken from a local path, because the repository is still private (row 2). |

**Summary: 7 ready, 3 partial, 5 blocked, 1 act.** Nothing blocked is blocked on this
unit. U18 landed on 2026-08-16 and took rows 3 and 16 green and row 12 down to a
presentational step. The remainder waits on U19 (video), U24 (LIVE, rungs 1 and 3, the
brakes), U25/U26's cold read, one repository-settings act and one scheduling act — the last
three all Julian's.

**The three rows most likely to be misread on 2026-08-17**, because each looks closer to
green than it is: row 6 is 1 rung of 4, not 4; row 7 is 1 brake of 3 and one of the other
two is falsified rather than pending; and row 16 has never been attempted by anyone.

---

## 6. Rules diff

**Fetched 2026-08-13** from `https://cockroachdb-ai.devpost.com/rules` and
`https://cockroachdb-ai.devpost.com/`, and diffed against `spec/02-COMPLIANCE-MATRIX.md`,
which was audited 2026-07-31.

**No change detected.** Every clause `02` relies on is still present and still says what
`02` says it says. The four verified by verbatim quote on the second fetch, because they are
the load-bearing ones:

- **B4** — "The Entrant must make the Project available free of charge and without any
  restriction, for testing, evaluation and use by the Sponsor, Administrator and Judges
  until the Judging Period ends." Unchanged.
- **A11** — "…creates software that enhances and builds upon the features and functionality
  included in the underlying open source product." Unchanged.
- **B2** — "The repository must be public and open source by including an open source
  license file (we recommend MIT or Apache 2.0). This license should be detectable and
  visible at the top of the repository page (in the About section)." Unchanged, including
  the About-section clause.
- **Amendment clause, §11.5** — "The terms and conditions of the Official Rules are subject
  to change at any time…" Unchanged, and still §11.5 as `02`'s header cites it.

Also confirmed unchanged: submission period June 30 2026 10:00 ET → **August 18 2026 5:00 pm
ET**; judging August 19 → **September 15 2026 5:00 pm ET**; winners on or around September 21
2026; the four CockroachDB tools with a **minimum of two**; the AWS service list with a
minimum of one plus "any other AWS service powering the agent's environment"; video "should
be less than three (3) minutes", public on YouTube or Vimeo, must show the project
functioning and must show the CockroachDB memory layer at work; the two required
identification fields and the two optional ones (architecture diagram, feedback); five
**equally weighted** criteria with ties broken by the first criterion, then the second —
and **Agentic Memory Design is still first**, which is what the whole narrative order
depends on.

**One cosmetic inconsistency, in the official pages rather than in our matrix.** The rules
page names criteria 2 and 4 "Technological Implementation" and "Product Readiness"; the
overview page names the same two "Technical Implementation" and "Production Readiness".
`02` and `01` use the rules page's wording. No action; noted so nobody treats it as an
amendment on 2026-08-17.

**Method caveat, and it is the reason to re-walk this on the day.** The fetch returns a
model's reading of the page, not the page. The four clauses above were re-fetched with a
verbatim-quote demand precisely because a summariser can drop a clause and produce a
false negative. On 2026-08-17, read the rules page with your own eyes; treat this diff as
evidence that nothing moved between 2026-07-31 and 2026-08-13, not as a substitute for
the required check.

---

## 7. Claims in §1–§4 not backed by a committed artifact

Everything here is either an unbuilt thing this draft is careful not to claim, or a claim
whose evidence is a live-cluster measurement recorded in `docs/verification-log.md` rather
than a file a judge can run. Listed so nobody has to take the draft on trust.

**Not backed by an artifact — these are pointers to work that does not exist yet:**

1. **The architecture diagram** (§1). `docs/architecture.md` appeared in the working tree
   while this file was being written and is uncommitted and unread by this unit; U18 owns
   it. §1 carries a placeholder pointer, not a claim, and the pointer must be replaced
   before the description is pasted.
2. **The demo URL's anonymity from a clean machine** (§1, §5 row 4). Verified anonymously
   over the network from here; §F's stronger form is Julian's act on a machine that never
   touched the project.
3. **"A clean clone reproduces the benchmark"** is *not* claimed in §1, deliberately, because
   nobody has tried it. `summary.md`'s reproducibility text is quoted as the results
   directory's own claim.

**Backed only by a verification-log measurement, not by a runnable artifact:**

4. **The Bedrock rate ($3.30 / $16.50)** — read from this account's Cost Explorer. Not
   reproducible by a judge, and the AWS Price List API does not carry Sonnet 4.5 at all.
5. **The Request Unit figure (2.81M of 60M, 4.7%)** — Console-only; every Cloud API usage
   endpoint returns 404.
6. **The managed MCP server measurements** (`managed-mcp`, 23502 vs 42501) — reproducible
   only with a Cloud service account at Cluster Operator, which a judge will not have.
7. **The changefeed delivery figure (~126ms)** — `npm run gate:stream` reproduces it, but
   only against a deployed stack with a running changefeed job, not from a clean clone.
8. **The suite figure (338 tests across 29 files, ~600s)** — recorded in the verification
   log on 2026-08-13. This unit did not run the suite; §1 does not quote a test count, only
   the specific assertions each claim depends on.
9. **The retry-backoff measurement (1/12 → 0/12 exhaustions at 250ms)** — a 12-run probe
   recorded in the log; the committed test asserts behaviour relative to the constant, not
   the failure rate.

**Two claims in `02` that this file deliberately contradicts, so the contradiction is
visible rather than silent:**

10. `02` A4 says "4 of 4 [CockroachDB tools] used". **Two of four are used** (Distributed
    Vector Indexing, Agent Skills). The managed MCP server was measured and rejected; the
    ccloud CLI is not used at all. Two still satisfies the rule's minimum of two.
11. `02` §C item 4 says "the agent consumes `cockroachlabs/cockroachdb-skills` for schema
    and query decisions". **There is no reference to that repository anywhere in `src/`,
    `scripts/`, `skills/`, `infra/` or `package.json`** — only in `spec/`. §2 above claims
    the publishing direction only, which is real and tested. If the consuming direction is
    wanted for A11, it has to be built, not asserted.
