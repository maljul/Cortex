# Verification log

What was checked against a live cluster, when, and what it actually returned.

Rules for this file, from `spec/10-KICKOFF-PROMPT.md`:

- Paste **actual output**, not a summary of it. "Worked" is not a result.
- If a check fails, record the exact error text and which fallback you took.
- Never write a placeholder number. Write `TBD`.

Cluster: `agent-hack-30704`, CockroachDB Cloud on `aws-us-east-1`,
`CockroachDB CCL v26.2.5 (x86_64-pc-linux-gnu, built 2026/07/28 18:56:00, go1.25.5)`.
Tier: **Basic** (the free tier), which is what `spec/04-ARCHITECTURE.md` §8 assumed
for V1 and V2. Both assumptions held.
Database `defaultdb`, SQL user `julian`, `sslmode=verify-full`.

`SET CLUSTER SETTING feature.vector_index.enabled` is permitted for this user, so
`sql/001_init.sql` line 6 does not block the migration.

Date started: 2026-08-01 · Cluster first reached: 2026-08-09

---

## V1 — Vector index with a prefix column

Spec: `spec/04-ARCHITECTURE.md` §8 · Fallback: brute-force ordering, no index

**Result:** PASS, but only after fixing an opclass bug in our own SQL. Vector
indexes are creatable on this cluster, the prefix column works, and isolation
genuinely lives in the index.

The nearest-neighbour query was correct from the start. Three rows from scope 1,
nearest first; the scope-2 row is absent, which is the property that matters:

```
[
  { "id": "99dff10d-8dcb-4bdd-8729-03f7b9b329ae", "dist": 0 },
  { "id": "74ee98e0-c905-44f2-98ca-b32d52d712c5", "dist": 0.006116251198662548 },
  { "id": "3f6446d2-b996-4805-bba5-2938b68d1209", "dist": 1 }
]
```

Did the EXPLAIN plan mention the vector index rather than a full scan? **Not at
first — it full-scanned**, while still returning those correct rows:

```
• top-k
│ order: +column8
│ k: 3
└── • render
    └── • filter
        │ filter: scope = '00000000-0000-0000-0000-000000000001'
        └── • scan
              missing stats
              table: _v1@_v1_pkey
              spans: FULL SCAN

index recommendations: 1
1. type: index creation
   SQL command: CREATE INDEX ON defaultdb.public._v1 (scope) STORING (e);
```

The index existed. `SHOW CREATE TABLE _v1` returned:

```
VECTOR INDEX _v1_scope_e_idx (scope, e vector_l2_ops)
```

**Cause: operator/opclass mismatch, not a tier or version limit.** The default
opclass is `vector_l2_ops`, which serves `<->` but not `<=>`. Every query in
`spec/03-MEMORY-MODEL.md` orders by `<=>` (§4.1 recall, §4.2 dedupe, §4.4
consolidation) and `DEDUPE_THRESHOLD` is specified as cosine distance at §5, so
the schema was asking for cosine against an L2 index. Four EXPLAINs isolate it:

| Query | Index opclass | Rows | Plan |
| --- | --- | --- | --- |
| `<->` | `vector_l2_ops` | 4 | vector search |
| `<->` | `vector_l2_ops` | 2000 | vector search |
| `<=>` | `vector_l2_ops` | 2000 | **FULL SCAN** |
| `<=>` | `vector_cosine_ops` | 2000 | vector search |

Row count was never the factor — it indexed four rows happily. With the opclass
corrected the plan uses the index, and the prefix column bounds the search:

```
• top-k
└── • render
    └── • lookup join
        │ table: _v1@_v1_pkey
        └── • vector search
              table: _v1@_v1_scope_e_idx
              prefix spans: [/'00000000-0000-0000-0000-000000000001' - /'00000000-0000-0000-0000-000000000001']
```

That `prefix spans` line is the evidence for `spec/03-MEMORY-MODEL.md` §3's claim
that isolation lives in the index rather than in a `WHERE` clause. **V5 below
retests that claim directly and finds it false as stated** — the prefix bounds the
search when it is supplied, but omitting it falls back to a full scan rather than
returning nothing. Read this section together with V5.

**Fallback not needed.** Fixed instead, in `sql/001_init.sql` (both
`intents_semantic` and `findings_semantic`) and in `sql/000_verify.sql`.

Worth stating plainly: with the default opclass this would have shipped. Results
stay correct, so nothing fails — the demo corpus is small enough that a full scan
looks instant. The submission would have claimed a vector index it was not using.

---

## V4 — Row-level TTL

Spec: `spec/03-MEMORY-MODEL.md` §1 · Fallback: none specified — working memory
reclamation depends on this

**Result:** PASS. Both storage parameters were accepted and the sweeper actually
reclaimed the row. Working-memory reclamation stands, which matters because this
is the one check with no fallback.

`SHOW CREATE TABLE _v4` — note the cluster added `ttl = 'on'` itself:

```
CREATE TABLE public._v4 (
	k STRING NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	CONSTRAINT _v4_pkey PRIMARY KEY (k ASC)
) WITH (ttl = 'on', ttl_expiration_expression = 'expires_at', ttl_job_cron = '*/1 * * * *', schema_locked = true);
```

Counts after inserting a row already an hour past `expires_at` at 14:53:53:

```
14:54:55 (+62s)   SELECT count(*) FROM _v4  ->  1
14:57:34 (+221s)  SELECT count(*) FROM _v4  ->  0
```

So reclamation landed somewhere between 62 and 221 seconds, against a
`*/1 * * * *` cron. **The two-minute wait this file prescribes is not long
enough** — at 62 seconds the row was still present, and a check at exactly two
minutes could plausibly have read `1` and been recorded as a failure. Allow four
minutes before concluding anything about TTL.

The lease semantics in `spec/03-MEMORY-MODEL.md` §1 should assume the same. A
claim is not reclaimed *at* `expires_at`; it is reclaimed at the next sweep after
it, so arbitration must treat an expired-but-present claim as free rather than
waiting for the row to vanish. The uniqueness constraint on
`(repo_id, resource_key)` is what makes that safe.

The same parameters are live on the real `claims` table, confirmed after applying
`sql/001_init.sql`:

```
ttl = 'on', ttl_expiration_expression = 'expires_at', ttl_job_cron = '*/1 * * * *'
```

---

## V2 — Changefeed with a webhook sink

Spec: `spec/04-ARCHITECTURE.md` §8 · Fallback: EventBridge Scheduler polling a
watermark every two seconds · **Time box: 20 minutes, then take the fallback**

**Result:** PASS on availability, which was the risky half. Delivery to a real
endpoint is still outstanding — it needs a webhook URL and nothing else.
**The fallback is not needed.**

The assumption under test was that sink-based changefeeds might be unavailable on
this tier. They are not. `CREATE CHANGEFEED` against a deliberately unreachable
host returned a job rather than a licensing or tier refusal:

```
CREATE CHANGEFEED FOR TABLE _v2
  INTO 'webhook-https://example.invalid/probe?insecure_tls_skip_verify=true'
  WITH updated, resolved = '10s';

  job_id: 1200000303041118209
```

Splitting the question this way meant the 20-minute time box never had to be
spent waiting on an external URL. `SHOW CHANGEFEED JOBS` then proved the cluster
reached the network and failed only on DNS:

```
status:         running
running_status: transient error: webhook sink request failed: Post
                "https://example.invalid/probe": dial tcp: lookup example.invalid
                on 172.20.0.10:53: no such host
error:          (empty)
```

So outbound HTTPS from the cluster to a webhook sink works. Probe job cancelled.

**Delivery confirmed** against a live webhook.site endpoint on Basic. The job
reached a steady delivering state rather than the DNS error above:

```
job_id:         1200003867318321153
status:         running
running_status: running: resolved=1786282517.706972690,0
error:          (empty)
```

An advancing `resolved` timestamp is the delivery proof: the sink is
acknowledging, because a changefeed only advances `resolved` once the endpoint
accepts. The events fired were an `INSERT` of row 2 and an `UPDATE` of row 1,
with `resolved = '10s'` heartbeats between them. Job cancelled afterwards — a
changefeed left running consumes RUs continuously on Basic.

**V2 therefore passes in full, on the free tier, and the EventBridge-Scheduler
fallback is not needed.**

Two things that fell out of this and belong in the design:

- A changefeed to a dead sink stays `running` with a **transient** error and
  retries indefinitely; it does not fail. The "changefeed stalled" row in
  `spec/04-ARCHITECTURE.md` §6 is therefore right that consolidation lags rather
  than breaks, but the staleness badge cannot be driven by job status — status
  stays `running` throughout. Drive it from the last `resolved` timestamp.
- `insecure_tls_skip_verify=true` is fine for a webhook.site probe and must not
  survive into the deployed API Gateway sink.

---

## V3 — Historical query window

Spec: `spec/03-MEMORY-MODEL.md` §6 · Fallback: drop the time-travel panel

**Result:** PASS. The window is **4500 seconds — 75 minutes**. The time-travel
panel survives; the fallback is not needed.

Which offset first failed, and the exact GC-threshold error: **no GC-threshold
error was produced, and the method in this file cannot produce one.** Every offset
from `-30s` to `-72h` returned the same thing:

```
[13] SELECT count(*) FROM _v2 AS OF SYSTEM TIME '-30s'
  FAILED code=42P01
  relation "_v2" does not exist
```

That is name resolution, not garbage collection. `_v2` was seconds old, so at any
past timestamp it did not exist yet, and CockroachDB resolves the descriptor at
the historical timestamp before it ever consults the GC threshold — `42P01` wins
first. Probing outward to `-4h`, `-24h`, `-25h`, `-48h` and `-72h` changed
nothing. **Reading a table younger than the window can never surface the
boundary.** To get a real GC error the table must be older than the GC TTL, which
means waiting 75 minutes.

The authoritative answer, from `SHOW ZONE CONFIGURATION FOR TABLE _v2`:

```
ALTER RANGE default CONFIGURE ZONE USING
	range_min_bytes = 134217728,
	range_max_bytes = 536870912,
	gc.ttlseconds = 4500,
	num_replicas = 3,
	num_voters = 3,
	constraints = '{+region=aws-us-east-1: 3}',
	voter_constraints = '[]',
	lease_preferences = '[[+region=aws-us-east-1]]'
```

`gc.ttlseconds = 4500` is the rewind limit, and it confirms the ~75 minutes
`spec/03-MEMORY-MODEL.md` §6 assumed. Note it is on `RANGE default`, so it applies
cluster-wide rather than to this table.

The demo must therefore not offer a rewind beyond 75 minutes, and should read the
bound at runtime rather than hardcoding it — a zone-config change would otherwise
turn the panel into an error page, which rung 1 of the degradation ladder in
`spec/04-ARCHITECTURE.md` §5 forbids.

---

## V5 — Does the index prefix isolate tenants on its own?

Spec: `spec/03-MEMORY-MODEL.md` §2 · Prompted by: writing §8 test 8 (recall scoped
to repo A never returns repo B)

**Result: FAIL — the claim does not hold.** The prefix does not isolate tenants.
The `WHERE repo_id` clause does, and it is load-bearing.

§2 states that `VECTOR INDEX (repo_id, embedding)` "partitions the index by
repository, so one tenant's memory cannot surface in another tenant's recall even
if an application filter is forgotten. Isolation lives in the index, not in a
`WHERE` clause." V1 recorded `prefix spans` as evidence for that. V1 only ever
tested the case where the filter **is** present, so it could not have caught this.

Two `findings` rows, identical embeddings, different `repo_id`s. Same ordering,
with and without the filter:

```
with repo filter : [ 'repo A secret' ]
without filter   : [ 'repo A secret', 'repo B secret' ]
```

Repo B's row came back. The plans say why — supply the prefix and the vector index
is used and bounded; omit it and the planner does not refuse, it full-scans:

```
-- no prefix supplied
└── • scan
      table: findings@findings_pkey
      spans: FULL SCAN

-- prefix supplied
└── • vector search
      table: findings@findings_semantic
      prefix spans: [/'7dbd0b59-…-d3c2d205c02c' - /'7dbd0b59-…-d3c2d205c02c']
```

**What the prefix actually buys**, stated accurately so the README does not
overclaim it to a judge:

- Per-tenant recall is the indexed fast path, and its cost does not grow with
  other tenants' data.
- A forgotten filter is *visible* — it shows up as `FULL SCAN` in the plan rather
  than quietly serving from a shared index.

**What it does not buy:** a forgotten filter fails **open**, not closed. Isolation
is an application-level property of the query, exactly the thing §2 says it is not.

Consequences:

1. `spec/03-MEMORY-MODEL.md` §2 corrected; the design note no longer claims the
   index is the boundary.
2. `src/memory/recall.ts` carries the correction inline, so the `WHERE` clause is
   not "simplified away" later as redundant.
3. **This changes §8 test 9.** `cortex_demo` confinement cannot rest on the index
   prefix, which was the cheap reading of the §3 `[OPEN]` decision. Confinement has
   to come from the principal's own grants — a separate cluster, or row-level
   authorization — because an application query is exactly what an anonymous demo
   path might get wrong, and the index will not catch it.

---

## Bedrock model access

Per-account and per-region, and a classic day-three surprise. Checked 2026-08-09
by invoking, in `us-east-1`, on account `373468206278`.

**Result: SPLIT. Embeddings PASS, reasoning FAILS.** The critical path is clear;
LIVE mode is not.

There is no page to read a granted/not-granted status off — AWS retired the Model
access page and serverless models are enabled on first invocation. So access is
**only observable by invoking**, which is the form this check now takes.

### Embeddings — PASS

`amazon.titan-embed-text-v2:0`, invoked with `{"inputText":"hello"}`:

```
{"embedding":[-0.0538589172065258,0.04496605694293976,0.027725033462047577,
0.007151383440941572,0.040491316467523575,-0.03645389899611473, …],
 "inputTextTokenCount":2}

dimensions: 1024
```

1024 dimensions, matching the `VECTOR(1024)` declared on `intents.embedding` and
`findings.embedding`. **Nothing on the propose/recall critical path is blocked.**

### Reasoning — FAIL

`anthropic.claude-sonnet-5`, the model `spec/05-INTERFACES.md` §6 names as
`BEDROCK_REASON_MODEL`, is **not invocable on this account**. Identical error from
the bare id and from both inference profiles:

```
An error occurred (AccessDeniedException) when calling the InvokeModel operation:
anthropic.claude-sonnet-5 is not available for this account. You can explore other
available models on Amazon Bedrock.
```

`us.anthropic.claude-opus-5` returns the same, so this is the whole v5 family, not
one model.

**It is not the Anthropic use-case gate.** That was the suspected cause, and it is
ruled out — other Anthropic models on the same account invoke and reply normally:

| Model id | Result |
| --- | --- |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | OK — replied `ok` |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | OK — replied `ok` |
| `us.anthropic.claude-sonnet-5` | AccessDenied, not available for this account |
| `us.anthropic.claude-opus-5` | AccessDenied, not available for this account |

Both v5 ids appear in `list-foundation-models` output, so the catalogue listing a
model is not evidence that the account may invoke it. Only invoking is.

**Consequence.** LIVE reasoning is cut-list item 7 in `spec/08-BUILD-PLAN.md` §6,
so this does not endanger the submission or rule B4 — a replay-only demo still runs
fully live database behaviour. What it does endanger is the **video**, which
`08-BUILD-PLAN.md` §5 says is recorded in LIVE mode at 52–58h. Discovering this on
day three would have meant re-planning the video under time pressure.

**Decision:** set `BEDROCK_REASON_MODEL` to
`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, which works today. This still
satisfies `spec/04-ARCHITECTURE.md` §5's "smallest adequate model" — and
`us.anthropic.claude-haiku-4-5-20251001-v1:0` is the cheaper fallback if LIVE cost
becomes the binding constraint. Requesting v5 entitlement is worth doing in
parallel, but nothing may depend on it arriving.

---

## Service accounts

Three principals, per `spec/04-ARCHITECTURE.md` §3.

All three principals exist on the cluster (`SHOW USERS`): `cortex_reader`,
`cortex_writer`, `cortex_demo`, alongside `julian`, `admin`, `root`.

- `cortex_reader` created, `SELECT` only, verified with `SHOW GRANTS`: **YES**
- `cortex_writer` created, holds `SELECT` in addition to the write verbs:
  **YES, and this is correct** — see the resolution below
- `cortex_demo` created, confined to demo session scopes: **created, deliberately
  ungranted**
- Confinement mechanism chosen (separate cluster vs scoped `repo_id`s), and why:
  **still open** — `04-ARCHITECTURE.md` §3 `[OPEN]`, and V5 narrowed it

`SHOW GRANTS ON TABLE claims`, filtered to the `cortex%` principals:

```
grantee          privilege_type
cortex_reader    SELECT
cortex_writer    DELETE
cortex_writer    INSERT
cortex_writer    SELECT
cortex_writer    UPDATE
```

The read plane is clean: `cortex_reader` holds `SELECT` and no write verb, which
is the property `spec/04-ARCHITECTURE.md` §3 rests its prompt-injection argument
on. `cortex_demo` holds nothing — granting it table-level writes before the §3
`[OPEN]` confinement decision is made would hand an anonymous visitor the whole
table and break the second invariant, so its grant waits on that decision rather
than being provisionally issued.

**Discrepancy between `sql/001_init.sql` and the spec — RESOLVED, in the spec's
favour of the SQL.** Two apparent over-grants were examined; both turned out to be
the spec understating what the write plane needs, so `04-ARCHITECTURE.md` §3 was
corrected rather than the SQL:

1. **`cortex_writer` has `SELECT`.** §3 said `INSERT`, `UPDATE`, `DELETE` "and
   nothing else". The write plane genuinely needs `SELECT`: Flow B returns the
   holder's identity and prior outcome on a blocked claim, which is a read, and
   `INSERT … RETURNING` requires the privilege regardless. §3 now says so, and
   states that the security claim rests on `cortex_reader` holding no write verb —
   which is the direction that is exactly enforced.
2. **Six tables, not four.** §3 said "all four tables", counting memory tiers.
   `repos` and `agents` are identity tables and both planes need them to resolve a
   claim to its holder. §3 now says six.

What remains open here is only `cortex_demo`'s confinement mechanism. V5 above
constrains it: it cannot rest on the vector index prefix, because a query missing
its `repo_id` filter fails open.
