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
CLI; **that command is built as of 2026-08-16 (U2) and it does not provision anything** —
`ccloud` is installed nowhere in this project, so `init` takes an operator DSN and brings a
cluster from empty to working, which is a narrower claim than §C's. §D lists Amazon
EventBridge and AWS Budgets; **Budgets is now deployed and armed, EventBridge is still
not.** B10 and B11 ask what was actually done, so §2 and §3 below are written from the
repository as it stands and replace §C and §D for submission purposes. `02` itself is not
edited by this unit.

Every number below comes from `bench/results/2026-08-12T18-35-38-014Z/summary.md` or from a
named entry in `docs/verification-log.md`. **LIVE model reasoning exists as of 2026-08-16**
— one deployed function can invoke a reasoning model, one metered run has been paid for, and
the daily cap is derived from that run rather than chosen. The page a judge opens without a
LIVE link still replays reviewed patches, and says so per run.

**Revised 2026-08-17.** This file was first drafted on 2026-08-13, when the ten-ticket
two-arm fleet workload was designed and unbuilt, and it said so; the 2026-08-16 revision
caught up with U21, U22, U23 and the rebuilt judge page (`npm run gate:workload` 20/20,
`npm run gate:async` 13/13 against the deployed stack, V56). It was still behind by five
commits. Since that revision: `cortex init` landed (U2), LIVE reasoning was deployed on the
fleet runner, all four degradation rungs were forced (`npm run gate:ladder`, 36/36), and
brake 3 was built and armed. Left alone, this description would have *understated* the
submission — which is the same class of error as overstating it, and the reason the draft is
re-derived from the repository rather than trusted.

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

On the page anyone can open, the patch bodies each agent applies are committed to the
repository and reviewable — **no model wrote that code**, and the page says so from the run's
own authorship records rather than from a fixed caption. What is live in every run is the
coordination: the embeddings, the dedupe search, the claim, the race decided by a unique
index, the changefeed, and the losses.

**There is a second mode, and judges have it.** A LIVE link — an unguessable token in the
URL, compared server-side, never echoed, with no field anywhere to type it into — has each
agent author its own hunks with Claude Haiku 4.5 on Bedrock instead of applying the committed
patch. Exactly one deployed function holds that permission. When the day's derived budget of
**30** LIVE runs is spent, or the permission is withdrawn by the cost brake, the agent applies
the reviewed patch instead and the page names the reason on screen; nothing errors and nothing
asks for a key. *(LIVE link: pasted into the Devpost submission field at submission time. It
is deliberately not written down in this repository.)*

**Run it on your own repository:** that is the CLI, and *there* you bring your own cluster
and your own credentials — which is correct for a tool that writes to your codebase, and is
a different thing from the demo. `node bin/cortex.mjs init` takes the connection string you
copy out of the CockroachDB Cloud Console and brings that cluster from empty to working:
roles created, credentials written to `.env` but never printed and never rotated, schema
applied, and the three privilege planes then proved by attempting statements against them.
Run it twice and the second run creates nothing and re-verifies everything. The hosted demo,
by contrast, never accepts a credential from a browser under any name, on any path, behind
any panel. There is no such field, and a test asserts its absence against the page source and
the deployed API.

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

*(Diagram: `docs/architecture.md`, committed. It shows the read plane as `cortex_reader` —
the managed MCP server is not the route — and it draws the reasoning model on the one
function that can invoke it, which is the fact a diagram is easiest to overstate.)*

Everything is on AWS and in one CockroachDB Cloud cluster. Agents read as a `SELECT`-only
SQL role over an ordinary Postgres driver. Agents write **only** through three typed MCP
tools, which is what makes arbitration unavoidable rather than advisory. A changefeed on
the memory tables carries committed rows to a Lambda, which consolidates a closed intent
into a durable finding and fans the row out to browsers over a WebSocket. Five deployed
Lambdas hold the whole hosted surface, and **exactly one of them is granted
`bedrock:InvokeModel` on a reasoning model**, by ARN — the identity probe, the demo router,
the changefeed sink and the WebSocket handler cannot reason at all.

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

**Failure modes are built and forced, not described.** `npm run gate:ladder` makes each limit
actually happen and then asks what the visitor is left holding: **36 checks, 36 pass.** No rung
may present an error page, a credential field or a payment gate, and none may misrepresent what
is still live — so each rung is checked on both halves.

- **Rung 1 — the LIVE budget is spent.** The day's counter is set to its cap and a
  capability-holding caller runs anyway. The run still starts, comes back REPLAY naming rung 1,
  states what degraded *and* what is still live, hands the runner no capability, and spends
  nothing further. A caller with no token and a caller with a wrong token get **byte-identical**
  answers that mention no quota, no budget and no capability — a page that hinted a gate existed
  would be its own leak — and the token is never echoed in any response.
- **Rung 1b — the reasoning permission itself is refused.** This is the runtime shape the cost
  brake below produces when it fires. A denied `bedrock:InvokeModel` does not throw: the agent
  still completes its ticket from the reviewed patch, and the refusal is reported rather than
  swallowed. Content degrades; nothing else does.
- **Rung 2 — every Bedrock embedding call refused with a 429**, forced on the arm the deployed
  page actually runs. Dedupe is **skipped rather than run at a threshold of zero** — the
  show-SQL transcript contains no similarity search at all, because the panel must not show a
  search the system says did not happen — and every intent written is marked in the database.
  The mark is a column, not a response field: a hash vector left in the candidate set corrupts
  every later dedupe decision long after Bedrock recovers, so `findDuplicate` carries
  `AND NOT embedding_degraded`.
- **Rung 3 — the per-session row budget is full** (200 rows per scope). The run is refused
  before it starts rather than failing part-way, with a 200 and not an error status; the
  response names rung 3 and says a new session is one click; the rows, the counters and the SQL
  log stay inspectable; and a new session really is one request.
- **Rung 4 — the write path is unreachable.** The demo plane is pointed at a socket nothing is
  listening on: 503 naming rung 4, nothing on the page claims to be live, and the demo comes
  back the moment the cluster does.

**All three cost brakes, in the state each is actually in:**

- **Brake 2 — the global run counter — is built and has been fired.** It lives in the cluster,
  it is a check and an increment in one statement at SERIALIZABLE, and the slot is spent when it
  is granted rather than when the run succeeds. Fired at its cap, LIVE stops and every route a
  judge needs still answers, which is the requirement rule B4 puts on any cost control here.
- **Brake 3 — an AWS Budget — is built and armed.** **$9, ANNUAL**: the judging window spans two
  calendar months, and a monthly budget would permit $9 twice against a $9 promise. Its cost
  filter names `Claude Haiku 4.5 (Amazon Bedrock Edition)` and `Claude Sonnet 4.5 (Amazon Bedrock
  Edition)` and deliberately **not** `Amazon Bedrock`, which on this account carries only the
  Titan embedding line — a Budget filtered on the obvious name would watch an empty meter and
  never fire. Its action is automatic and attaches a Deny on `bedrock:InvokeModel` to the one
  role that can reason, and to nothing else: the API, the SPA, the read path and the cluster are
  untouched, because a brake that took the project offline would be a rules violation rather than
  a saving. It is armed and has never fired; actual spend against it is $0.00.
- **Brake 1 is falsified, and its replacement is settled rather than skipped.** Reserved
  concurrency cannot be set on this account at any value (see the limitations). Its two intents
  are met by things that do exist: the run counter bounds *spend*, the account's own 10-slot
  concurrency ceiling bounds *fan-out*, and a managed policy attached to the fleet runner alone
  can be detached to stop model calls and nothing else.
**The number the brakes defend is derived, not chosen.** One real LIVE run was metered from
Bedrock's own `usage` — **16 model calls, 36,892 input and 10,255 output tokens** — and priced
at the rate this account has actually been billed at, read from Cost Explorer rather than from a
pricing page: **$3.30 per 1M input tokens and $16.50 per 1M output**. That is **$0.2910 a run**,
and the daily cap is `floor($9 ÷ $0.2910)` = **30**, computed in code from those two facts. If
the metered run were absent the cap computes to zero and LIVE is simply off, which is the
honest expression of "we have not measured what this costs". The rate is Sonnet 4.5's and the
fleet runs Haiku 4.5, whose own line had not yet appeared on this account's bill — every
published rate card puts Haiku below Sonnet, so pricing it this way makes the cap a floor and
the real spend smaller than the brake assumes.

**Serialization conflicts and exhausted retries are measured, not assumed.** Every write path
goes through one 40001 retry helper, five attempts with exponential backoff and jitter. The base
delay was raised 20ms → 250ms after measurement: at 20ms two colliding agents backed off by a
third of the window they collided in and restarted into each other, exhausting the cap on one run
in twelve; at 250ms that is zero in twelve and the modal retry count is 1. An agent that does
lose five times re-plans once, visibly, and is reported as contended rather than as an exception,
because the demo may not present an error page.

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
   What is fixed on the public page is the code each agent applies: every ticket carries a
   small checked-in patch, so an agent reads the real file, decides, claims through the one
   arbitration transaction, applies and closes. **No model wrote the committed code**, and the
   page says who wrote each run's hunks from that run's own records rather than from a caption.
   The naive lane is worktree isolation with clean merges — what the field actually ships — not
   a strawman.
3. **The demo has two modes and the public one replays those patches.** Embeddings are live
   Bedrock calls and database behaviour is fully live in both. A LIVE link makes the agents
   author their own hunks with a model; it is capped at 30 runs a day, derived from a $9 budget
   for the whole event, so a judge can exhaust it — at which point the run degrades to the
   reviewed patches and says which rung it is on. Two things are worth stating rather than
   glossing: a model-authored hunk that fails validation falls back to the committed patch, so a
   LIVE run can be a mixture, and the page reports the split; and the *decision* an informed agent makes is
   driven in both modes by comparing what recall returned against what consolidation wrote, so no
   cached model output sits in the causal path either way.
4. **The demo's naive arm and the benchmark's naive arm are different things.** The
   benchmark's writes a JSON file with last-write-wins; the demo's does the same thing to a
   JSONB cell, because an arm that touches no database executes no statements and so cannot
   demonstrate losing a write. The numbers are not comparable across the two.
5. **This account's Lambda concurrency limit is 10, not the AWS default of 1000,** and it
   cannot be raised from the CLI or subdivided. Ten simultaneous visitors can reach a 503.
   It is an account restriction, we have measured it, and the mitigation is to build for 10.
6. **Reserved concurrency is unavailable on this account at any value,** so the first of the
   three designed cost brakes is falsified rather than implemented. The other two are built —
   one has been fired, one is armed — and brake 1's two intents are met by the run counter, by
   the account's own concurrency ceiling and by a detachable model-invocation policy. None of
   those is a concurrency reservation, and calling them one would be the overstatement this
   list exists to prevent.
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

**`ccloud` is installed nowhere in this project and nothing here has ever run it.** That is
the whole of the answer, and it did not change when the CLI landed: `cortex init` was built on
2026-08-16 and it is deliberately **provisioning-optional**. It takes an operator connection
string — the one a person copies out of the Cloud Console — and brings a cluster from empty to
working: it creates the SQL roles by *parsing the migration* rather than from a hardcoded list,
writes their connection strings into `.env` without ever rotating one, applies the schema, and
then proves the privilege planes by attempting statements against them. Run it twice and the
second run creates nothing, appends nothing and re-verifies everything; that is its done-when
and it was closed by running it twice against the live cluster, both exits 0, with 45 tests
behind it and the cluster left exactly as found.

So the count stays **2 of 4**. Provisioning a cluster is the one thing `init` does not do, and
it is the only thing the ccloud tool is. Claiming a third tool on the strength of a CLI that
never invokes it would be exactly the inflation this section is written to avoid. The entry
point is `node bin/cortex.mjs init` — `npx cortex` resolves to an unrelated package on the
public registry and is not this CLI.

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

*(This replaces `02` §D, which lists one service that is not deployed and one that now is.
See the note at the top of this file.)*

| Service | Load-bearing function |
| --- | --- |
| **Amazon Bedrock** | Amazon Titan Text Embeddings V2 at 1024 dimensions embeds **every** intent and finding — live calls in the hosted demo, not cassettes. **Claude Haiku 4.5 authors the agents' hunks in the demo's LIVE mode**, on the fleet runner alone and scoped by ARN. Claude Sonnet 4.5 via the Converse API is the agent reasoner in the benchmark harness; its outputs are recorded once and replayed so the published run reproduces. |
| **AWS Lambda** | **Five functions**, and they are the whole hosted surface: the identity probe, the demo API (sessions, runs, state, the SQL log), the fleet runner that performs a visitor's two-arm run off the request path, the changefeed sink that consolidates a closed intent into a finding and fans the row out, and WebSocket connect/disconnect. The runner is the only one that may invoke a reasoning model; the concurrency budget the five share is written into the stack, because this account's ceiling is 10 and a sixth function would take from the same pool. |
| **Amazon API Gateway** | HTTP API for the demo routes, WebSocket API for the live memory stream, and the **ingress for CockroachDB's own changefeed webhook sink** — the database calls back into the application over it. |
| **Amazon DynamoDB** | Two tables: the WebSocket connection registry (so a changefeed row can be fanned out to every live browser) and the per-session SQL transcript the "show SQL" panel reads. Both carry a TTL attribute; neither is memory, which lives in the cluster. |
| **Amazon S3 + Amazon CloudFront** | Origin and distribution for the demo SPA. Anonymous, no login, no key. |
| **AWS Secrets Manager** | Every database connection string, the changefeed's webhook token, the LIVE capability token and the budget alert address are `{{resolve:secretsmanager:...}}` dynamic references resolved by CloudFormation at deploy time, never template values. This is not decoration: the first arrangement satisfied the "no credential in the repository" rule as written and left the credential in the synthesized template and in CloudFormation's stored copy. It was found by grepping the build artifact, not by reasoning about the rule. |
| **AWS Budgets** | Cost brake 3, and the only automatic bound on LIVE spend: a $9 **annual** cost budget — annual because the judging window spans two calendar months — filtered on the two `(Amazon Bedrock Edition)` Claude services, whose automatic action attaches an IAM Deny on `bedrock:InvokeModel` to the fleet runner's role and to nothing else. Armed, never fired, $0.00 actual. |
| **Amazon CloudWatch** | Structured logs for all five functions; the changefeed sink logs a consolidation failure and answers 200 anyway, so a stalled feed degrades to a staleness badge rather than blocking an agent. |

**One service the design calls for and the deployment does not have, stated plainly rather
than listed:**

- **Amazon EventBridge** was specified between the changefeed ingress and consolidation.
  The sink consolidates inline instead. What the bus would add over what exists is a
  *separate concurrency pool* for the two consumers — and on an account where reserved
  concurrency cannot be set at any value, there is no pool to separate. It would have added
  a hop and a failure mode for no behaviour this deployment can express.

**And one finding worth publishing whatever anyone builds:** a Budget filtered on the
`Amazon Bedrock` service would **never fire**. Anthropic model spend on this account bills
under `Claude Haiku 4.5 (Amazon Bedrock Edition)` and `Claude Sonnet 4.5 (Amazon Bedrock
Edition)`, which Cost Explorer treats as separate top-level services; `Amazon Bedrock` on the
same days carries only the Titan embedding line. The obvious filter is the one that watches an
empty meter, and it took reading this account's own bill to find that out.

Nine services deployed, each with one clear job — Bedrock, Lambda, API Gateway, DynamoDB, S3,
CloudFront, Secrets Manager, Budgets and CloudWatch — plus the IAM policies that are brake 3's
mechanism rather than a service anyone chose. We did not add a tenth for appearance: the rule
that requires meaningful integration cuts against sprinkling exactly as hard as it cuts against
omitting.

---

## 4. B13 — feedback on the CockroachDB AI tools

*(Optional field. `docs/verification-log.md` is the long version of this; every item below
has an entry there with the actual output.)*

We kept a verification log from the first day: what was checked against the live cluster,
what it returned, and what we did when it disagreed with the documentation. It runs to entry
V57. Four spec claims we wrote ourselves were falsified by invoking them, and each read
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
under a service name of its own — `Claude Haiku 4.5 (Amazon Bedrock Edition)`, `Claude Sonnet
4.5 (Amazon Bedrock Edition)` — rather than under `Amazon Bedrock`, so the obvious Budget
filter watches an empty meter. Our Budget names both Claude services for that reason, and we
found the names by asking Cost Explorer for its own dimension values rather than by guessing.
Both are worth a line in your AWS integration guide.

---

## 5. `02` §F — pre-submission checklist, walked

**First walked 2026-08-13, re-walked 2026-08-17** — the day §F is dated for. Rows that moved
between those two walks are re-graded here rather than annotated, and every row still marked
**BLOCKED** or **ACT** is an act nobody but Julian can perform.

| # | Item | Verdict | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Rules page re-fetched and diffed | **READY** | Fetched and diffed 2026-08-13 (§6 below) and **re-fetched 2026-08-17: no change**, including the deadline, the four-tool list with its minimum of two, and the five equally weighted criteria. §6's method caveat still stands — a fetch returns a model's reading of the page, so Julian's own read of the rules on the day is the stronger form and is the remaining act. |
| 2 | Repository public, MIT licence visible in About | **BLOCKED — one settings act, and it is the last one** | The `LICENSE` file is **committed and pushed**; origin matches HEAD, so the only thing GitHub is missing is permission to look. The repository is still private, and flipping it is a settings act in Julian's account that no script here can perform. B2 wants the licence **detectable in the About section**, which needs both the file and the visibility. The licence is **MIT** — Julian's call on 2026-08-13, settling a three-way disagreement in which `LICENSE` and `package.json` said ISC while `02` B2, `spec/09` §1 and the rules' own recommendation said MIT. `LICENSE`, the `package.json` `license` field, `README.md` and `docs/third-party.md` all say MIT. |
| 3 | README has setup, run instructions, prior-work disclosure, third-party licences | **READY** | `README.md` and `docs/third-party.md` are committed (U18, 2026-08-16). The first screen carries the two-metric table, the demo URL and the try-it / run-it split; prior work is disclosed under A9; third-party licences are enumerated with their tallies and the regeneration commands. Row 16 — the clean-clone reproduction the README documents — now passes. |
| 4 | Demo URL loads anonymously, no key, no login | **READY, pending Julian's own act** | The CloudFront page was fetched anonymously on 2026-08-13, and the deployed API was driven anonymously end to end again on 2026-08-17 — `npm run gate:async` against the redeployed stack: a run started, 90 fleet events and one terminal message off the socket, 43 changefeed rows. **The page itself has been rebuilt since that fetch** (the judge redesign, deployed 2026-08-16), so the fetch on record is of an older page. §F's full form is a **private window on a machine that never touched this project**, which is Julian's act and not a script's, and it covers both. |
| 5 | No credential input field anywhere in the demo UI | **READY, with one act on the day** | Three layers. A test scans the page source for any input, form or credential-shaped name including commented out, and it runs against the page as it is now; the deployed API refuses a credential-shaped field in the body **and** on the query string with `400 {"field":"query.dsn"}`, proved by the same `curl` returning 404 before the fix and 400 after. The third layer is stale by design: the rendered DOM was driven in a browser on 2026-08-13, and the page has been rebuilt and redeployed since, so **re-drive the deployed DOM on the day**. The LIVE capability does not weaken this — it is a URL parameter compared server-side, never a field, and it is never echoed back into the page. |
| 6 | All four degradation rungs exercised by forcing the limit | **READY — 4 of 4, plus a variant** | `npm run gate:ladder`, **36/36**, each rung forced by making its limit actually happen: rung 1 sets the day's LIVE counter to its cap and runs anyway; rung 1b refuses the `bedrock:InvokeModel` grant itself, which is the runtime shape the cost brake produces; rung 2 refuses every embedding call with a 429 **on the arm the deployed page runs**, not on a path it no longer calls; rung 3 fills a scope's 200-row budget; rung 4 points the demo plane at a socket nothing is listening on. Every rung is checked on both halves of `04` §5 invariant 2 — what degraded and what is still true — and `npm run gate:degrade` is an alias for the same script, so the earlier rung-2 evidence is not lost. |
| 7 | Each of the three cost brakes fired deliberately, demo stayed reachable | **READY, with one honest caveat** | Brake 2 (the global run counter) was **fired**: driven to its cap, LIVE stopped, and the run, state, SQL-log and session routes all still answered — which is the rule B4 half of this row. Brake 3 (the Budget) is **built and armed**: $9, ANNUAL, filtered on the two `(Amazon Bedrock Edition)` Claude services, automatic action attaching an IAM Deny on `bedrock:InvokeModel` to the runner's role alone; read back from the account as `STANDBY`, HEALTHY, $0.00 actual. **The caveat: the Budget itself has never fired**, because firing it means spending $9, and what was forced instead is the state it produces — rung 1b runs the fleet with that permission denied and the agents complete their tickets from the reviewed patches. Brake 1 (reserved concurrency of 2) stays **falsified on this account at any value**; its replacement is settled and named in §1 rather than left blank. |
| 8 | README and Devpost both state the zero-setup promise, and that BYO-credentials is CLI-only | **READY** | §1's "How to try it" says both, in the same breath, deliberately. The README's first screen makes the same split, and it is committed and pushed — the reason this row read PARTIAL is spent. |
| 9 | Weekly anonymous reachability check scheduled through 2026-09-15 | **ACT — not scheduled** | Nothing schedules it. §E WATCH-4 is explicit that checking the cluster is unpaused is **not** the same test and will not catch a broken deploy, an expired certificate, or a guardrail that fired and never reset. The check is: open the demo URL in a private window on a machine that has never touched this project and run a scenario end to end. |
| 10 | LIVE mode works and its daily cap degrades gracefully to REPLAY | **READY, with one paste act** | LIVE reasoning is built and deployed on the fleet runner alone, and one real run has been metered and paid for — 16 model calls, 36,892 input and 10,255 output tokens, $0.2910 — from which the cap of **30 runs a day** is computed in code rather than chosen. Rung 1 forces the degradation: at the cap a capability holder still gets a run, in REPLAY, naming rung 1 and saying what is still live, with no capability passed on and nothing further spent. **The act:** the LIVE link has to be pasted into the Devpost submission field on the day. It is deliberately written down nowhere in this repository. |
| 11 | Video under 3:00, public, English, shows terminal and memory layer, no third-party marks | **BLOCKED** | Not recorded, and it is the largest remaining piece of work. **The constraint the 2026-08-13 walk added is now lifted:** `07` §4 and §5 say the video is recorded in LIVE mode, and LIVE mode now exists, so the instruction can be followed as written and narrating live inference is accurate rather than an A7 breach. Recording in LIVE spends slots from the day's 30. |
| 12 | Devpost description contains the benchmark table and the architecture diagram | **PARTIAL** | Table: **ready**, §1, quoted from the committed results directory with its limitations attached. Diagram: `docs/architecture.md` is committed, its Mermaid source shows the read plane as `cortex_reader`, and it was corrected when LIVE landed — it now draws Claude Haiku 4.5 on the fleet runner alone and labels the Budget built, where an earlier version said no deployed function could invoke a reasoning model at all. **What remains is presentational** — §1 carries a pointer, and Devpost renders no Mermaid, so the diagram must be exported to an image and attached before the description is pasted. |
| 13 | B10 and B11 answers pasted from sections C and D | **READY, with a deliberate deviation** | **Do not paste §C and §D.** §C describes an abandoned read path and a CLI provisioning clusters through a tool this project has never run; §D lists a service that is not deployed beside one that now is. §2 and §3 of this file are the answers, rewritten from the repository. This row's wording in `02` §F is now wrong and should be re-pointed when §C and §D are corrected. |
| 14 | Optional feedback field completed in detail | **READY** | §4, twelve items, each traceable to a verification-log entry with real output. |
| 15 | AWS Budget alarm active; cluster not near free-tier limits | **READY** | Budget: **built and armed** — `cortex-live-reasoning`, $9 ANNUAL, filtered on the two `(Amazon Bedrock Edition)` Claude services, automatic IAM Deny action on the runner's role; read back from the account as `STANDBY` and HEALTHY with $0.00 actual (row 7). Cluster: **healthy** — 2.81M of 60M Request Units, 4.7%, read from the Console after two weeks of heavy use. The reading is Console-only; the Cloud API returns 404 for every usage endpoint. What is exhaustible is burst throughput, which refills with rest. |
| 16 | Benchmark results reproduce from a clean clone | **READY** | **Done, V57, 2026-08-16.** Clone to an empty directory, `npm ci`, `npx tsc --noEmit` clean, `npm run bench:results`: every coordination row identical to the published table, only `claim_p50` (732 → 778) and `claim_p95` (818 → 967) moved, both arms recording `mode=replay` and `liveCalls: {embed: 0, reason: 0}`. It also found a reproduction blocker — the committed recipe named `CORTEX_DSN` where the CORTEX arm runs on `CORTEX_WRITER_DSN` — now corrected in place with no published number moved. **Caveat:** the clone was taken from a local path, because the repository is still private (row 2). |

**Summary: 12 ready, 1 partial, 2 blocked, 1 act.** Five rows changed verdict since the
2026-08-16 revision and all five moved forward: rows 6, 7, 10 and 15 on LIVE reasoning, the
forced ladder and the armed Budget, and row 8 because the README is committed and pushed. Three
of the twelve ready rows still carry an act on the day — open the demo cold from an untouched
machine (row 4), re-drive the deployed DOM (row 5), paste the LIVE link (row 10).

**What is genuinely left is not code.** The video (row 11), flipping the repository to public
(row 2), and scheduling the weekly reachability check (row 9). All three are Julian's, and the
first is the only one that takes real time.

**The three rows most likely to be misread on 2026-08-17**, because each reads greener or
redder than it is: row 7 says READY and the Budget has **never fired** — what was forced is the
state it produces, not the Budget itself, and firing it for real would mean spending the whole
budget; row 5 says READY on three layers of which the browser layer predates the current page;
and row 2 is one settings click, not a piece of work, which is exactly the kind of row that gets
left until after the deadline.

---

## 6. Rules diff

**Fetched 2026-08-13 and re-fetched 2026-08-17** from
`https://cockroachdb-ai.devpost.com/rules` and `https://cockroachdb-ai.devpost.com/`, and
diffed against `spec/02-COMPLIANCE-MATRIX.md`, which was audited 2026-07-31.

**No change detected, on either fetch.** Every clause `02` relies on is still present and
still says what `02` says it says. The four verified by verbatim quote, because they are
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

**Method caveat, and it is why the 2026-08-17 re-fetch does not close this.** The fetch
returns a model's reading of the page, not the page. The four clauses above were re-fetched
with a verbatim-quote demand precisely because a summariser can drop a clause and produce a
false negative. Read the rules page with your own eyes before submitting; treat this diff as
evidence that nothing moved between 2026-07-31 and 2026-08-17, not as a substitute for
the required check.

---

## 7. Claims in §1–§4 not backed by a committed artifact

Everything here is either an act still outstanding, or a claim whose evidence is a live-cluster
or AWS-account measurement recorded in `docs/verification-log.md` rather than a file a judge can
run. Listed so nobody has to take the draft on trust. Items that closed since the last revision
are re-graded in place rather than struck out, because what a claim used to lack is part of
knowing what it now has.

**Still an act rather than an artifact — one of the three items here shrank to nothing and
that is recorded rather than deleted:**

1. **The architecture diagram** (§1). `docs/architecture.md` is now committed (U18), and it
   was corrected again when LIVE reasoning landed, so §1's pointer is a pointer to a real
   file rather than to intended work. What is left is presentational: Devpost renders no
   Mermaid, so the diagram must be exported to an image and attached.
2. **The demo URL's anonymity from a clean machine** (§1, §5 row 4). Verified anonymously
   over the network from here; §F's stronger form is Julian's act on a machine that never
   touched the project.
3. **"A clean clone reproduces the benchmark"** — this read "not claimed, because nobody has
   tried it" until 2026-08-16, when somebody did (V57). It reproduces: every coordination row
   identical, both arms recording `mode=replay` and no live calls. The clone was taken from a
   local path because the repository is still private, so the last hop a judge takes — clone
   from GitHub — is the one nobody has walked.

**Backed only by a verification-log or account measurement, not by a runnable artifact:**

4. **The Bedrock rate ($3.30 / $16.50)** — read from this account's Cost Explorer. Not
   reproducible by a judge, and the AWS Price List API does not carry Sonnet 4.5 at all. It is
   Sonnet's rate standing in for Haiku's, which had not yet appeared on this account's bill;
   that substitution makes the derived cap a floor and is stated wherever the cap is.
5. **The metered LIVE run (16 calls, 36,892 in, 10,255 out, $0.2910)** — summed from Bedrock's
   own `usage` over one real run, with two truncated calls charged at a bound rather than
   dropped. A judge can watch a LIVE run; they cannot re-derive this figure.
6. **Brake 3's armed state** (`STANDBY`, HEALTHY, $0.00 actual) — read back from the AWS
   account. The Budget, its filter, its action and its annual period are all in the committed
   CDK stack and asserted there; the *state* is an account fact.
7. **The Request Unit figure (2.81M of 60M, 4.7%)** — Console-only; every Cloud API usage
   endpoint returns 404.
8. **The managed MCP server measurements** (`managed-mcp`, 23502 vs 42501) — reproducible
   only with a Cloud service account at Cluster Operator, which a judge will not have.
9. **The changefeed delivery figure (~126ms)** — `npm run gate:stream` reproduces it, but
   only against a deployed stack with a running changefeed job, not from a clean clone.
10. **The suite figure (423 tests across 34 files, ~600s)** — recorded in the verification log
    on 2026-08-13. The tree now carries 39 test files; nothing in this revision ran the suite,
    so that figure is the last one measured rather than the current one. §1 quotes no test
    count at all, only the specific assertions each claim depends on.
11. **The retry-backoff measurement (1/12 → 0/12 exhaustions at 250ms)** — a 12-run probe
    recorded in the log; the committed test asserts behaviour relative to the constant, not
    the failure rate.

**Two claims in `02` that this file deliberately contradicts, so the contradiction is
visible rather than silent:**

12. `02` A4 says "4 of 4 [CockroachDB tools] used". **Two of four are used** (Distributed
    Vector Indexing, Agent Skills). The managed MCP server was measured and rejected; the
    ccloud CLI is not used at all, and `cortex init` being built does not change that —
    `ccloud` is installed nowhere here and nothing has ever invoked it, so the CLI does
    everything *after* provisioning and claims nothing about provisioning. Two still satisfies
    the rule's minimum of two.
13. `02` §C item 4 says "the agent consumes `cockroachlabs/cockroachdb-skills` for schema
    and query decisions". **There is no reference to that repository anywhere in `src/`,
    `scripts/`, `skills/`, `infra/` or `package.json`** — only in `spec/`. §2 above claims
    the publishing direction only, which is real and tested. If the consuming direction is
    wanted for A11, it has to be built, not asserted.
