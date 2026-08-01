# 03 — Memory Model

This is the core specification. Every other document defers to it. Load it into the
implementing agent's context for all data-layer work.

---

## 1. Memory tiers

Four tiers, each a real database primitive rather than an application convention.
State this mapping in the README; it is the single strongest signal for the
Agentic Memory Design criterion.

| Tier | Table | Lifetime mechanism | Contains |
| --- | --- | --- | --- |
| Working | `claims` | Row-level TTL, minutes | who currently holds the right to act on a resource |
| Episodic | `intents` | append-only, TTL 30 days on closed rows | every attempt: what was wanted, by whom, what happened |
| Semantic | `findings` | durable, no TTL | facts about this codebase, distilled from closed intents |
| Procedural | `action_ledger` | durable, no TTL | the idempotent record of side effects actually applied |

A dead agent releases nothing by hand. Its claims expire and are reclaimed by the TTL
job. That is the resilience story for the Product Readiness criterion, and it costs
one storage parameter.

## 2. Schema

```sql
-- Cluster prerequisites. [VERIFY] both on the target cluster before building.
SET CLUSTER SETTING feature.vector_index.enabled = true;
-- Creating a vector index on a non-empty table additionally requires
-- sql_safe_updates to be disabled for that session.

CREATE TABLE repos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        STRING NOT NULL UNIQUE,          -- 'owner/name'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id            STRING PRIMARY KEY,            -- 'agent-3'
  repo_id       UUID NOT NULL REFERENCES repos(id),
  kind          STRING NOT NULL,               -- external | scripted
  session_id    UUID NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WORKING MEMORY -----------------------------------------------------------
CREATE TABLE claims (
  repo_id       UUID NOT NULL,
  resource_key  STRING NOT NULL,               -- see §3
  intent_id     UUID NOT NULL,
  holder        STRING NOT NULL,               -- agents.id
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo_id, resource_key),
  INDEX (repo_id, intent_id)
) WITH (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '*/1 * * * *'
);

-- EPISODIC MEMORY ----------------------------------------------------------
CREATE TABLE intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id        UUID NOT NULL,
  agent_id       STRING NOT NULL,
  statement      STRING NOT NULL,              -- natural language, agent-authored
  resource_keys  STRING[] NOT NULL,
  embedding      VECTOR(1024) NOT NULL,        -- Titan Text Embeddings V2
  status         STRING NOT NULL DEFAULT 'proposed',
                 -- proposed | in_flight | done | abandoned | deduped
  deduped_of     UUID NULL,                    -- set when status = 'deduped'
  outcome        JSONB NULL,                   -- { result, files_changed, notes }
  tokens_spent   INT8 NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ NULL,
  VECTOR INDEX (repo_id, embedding),
  INDEX (repo_id, status, created_at DESC),
  CHECK (status IN ('proposed','in_flight','done','abandoned','deduped'))
);

-- SEMANTIC MEMORY ----------------------------------------------------------
CREATE TABLE findings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id            UUID NOT NULL,
  fact               STRING NOT NULL,
  embedding          VECTOR(1024) NOT NULL,
  source_intent_id   UUID NULL,
  confidence         FLOAT8 NOT NULL DEFAULT 0.5,
  corroborations     INT8 NOT NULL DEFAULT 1,
  contradictions     INT8 NOT NULL DEFAULT 0,
  last_confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  VECTOR INDEX (repo_id, embedding),
  CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

-- PROCEDURAL MEMORY --------------------------------------------------------
CREATE TABLE action_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id          UUID NOT NULL,
  intent_id        UUID NOT NULL,
  idempotency_key  STRING NOT NULL,
  action           STRING NOT NULL,            -- write_file | run_migration | open_pr
  payload_digest   STRING NOT NULL,            -- sha256 of the effect payload
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, idempotency_key)
);
```

### Design notes worth defending out loud

- **The vector index prefix is not decoration.** `VECTOR INDEX (repo_id, embedding)`
  partitions the index by repository, so one tenant's memory cannot surface in
  another tenant's recall even if an application filter is forgotten. Isolation lives
  in the index, not in a `WHERE` clause.
- **`claims` is keyed by `(repo_id, resource_key)`, not by a surrogate id.** The
  uniqueness of the resource key *is* the mutual exclusion. There is no separate lock
  object to get out of sync.
- **`intents` is append-only.** Nothing is deleted, only transitioned. This is what
  makes the episodic tier auditable and what makes the benchmark measurable.
- **`action_ledger` carries the idempotency key uniquely per repo.** A retried tool
  call collides on insert instead of applying the effect twice.

## 3. Resource key grammar

Resource keys MUST be canonical strings so that two agents describing the same target
produce the same key. Normalise before hashing: POSIX separators, no leading `./`,
lowercase scheme.

```
file:<repo-relative path>          file:src/auth/login.ts
glob:<repo-relative glob>          glob:src/auth/**
migration:<id>                     migration:0042
service:<name>:<verb>              service:api:deploy
```

Overlap rule: a `glob:` claim conflicts with any `file:` claim it matches, and the
reverse. Because a naive `ON CONFLICT` cannot express that, the acquisition
transaction MUST expand globs to the concrete file set at claim time and insert one
row per file, plus one row for the glob itself. `[OPEN]` If expansion produces more
than 200 keys, the implementer should decide between refusing the claim and claiming
at directory granularity; refusing is safer and is the default until measured.

## 4. The four memory operations

### 4.1 RECALL — read path, through the managed MCP server

Runs before an agent starts work. Read-only, no transaction needed, executed as SQL
through the CockroachDB Cloud Managed MCP Server under the read-only service account.

```sql
WITH near AS (
  SELECT id, fact, source_intent_id, confidence, contradictions,
         embedding <=> $1 AS dist
  FROM findings
  WHERE repo_id = $2
  ORDER BY embedding <=> $1
  LIMIT 40
)
SELECT n.fact,
       n.confidence,
       n.dist,
       count(i.id) FILTER (WHERE i.outcome->>'result' = 'reverted') AS times_reverted,
       max(i.closed_at)                                             AS last_touched
FROM near n
LEFT JOIN intents i ON i.id = n.source_intent_id
WHERE n.dist < 0.35
GROUP BY n.fact, n.confidence, n.dist
ORDER BY times_reverted DESC, n.dist ASC
LIMIT 8;
```

This query is the artifact to put on screen in the video. It joins semantic
similarity with structural outcome history in one statement on one snapshot. A vector
database cannot run it. Say exactly that, in those words.

### 4.2 DEDUPE + CLAIM — the arbitration transaction

One transaction. Both steps read and write the same snapshot. This is the whole
architectural argument, so the implementation must not be clever about splitting it.

```sql
BEGIN;  -- SERIALIZABLE is the default isolation level

-- Step 1: is someone already doing this, or has it already been done?
SELECT id, agent_id, status, outcome, embedding <=> $emb AS dist
FROM intents
WHERE repo_id = $repo
  AND status IN ('in_flight', 'done')
ORDER BY embedding <=> $emb
LIMIT 5;
-- Application rule: if min(dist) < DEDUPE_THRESHOLD, ROLLBACK and return
--   { decision: 'deduped', of: <id>, holder: <agent_id>, outcome: <outcome> }

-- Step 2: register the intent
INSERT INTO intents (id, repo_id, agent_id, statement, resource_keys, embedding, status)
VALUES ($iid, $repo, $agent, $stmt, $keys, $emb, 'in_flight');

-- Step 3: acquire every key, all or nothing
INSERT INTO claims (repo_id, resource_key, intent_id, holder, expires_at)
SELECT $repo, k, $iid, $agent, now() + $lease_ttl
FROM unnest($keys::STRING[]) AS k
ON CONFLICT (repo_id, resource_key) DO NOTHING
RETURNING resource_key;
-- Application rule: if the returned row count is less than array_length($keys),
--   ROLLBACK and return { decision: 'blocked', contested: [...] }

COMMIT;
```

**Invariants this transaction must uphold.** Write them as tests before writing the
implementation.

1. **All or nothing.** An agent never holds a strict subset of the keys it asked for.
   Partial ownership produces interleaved half-edits, which is worse than losing.
2. **Dedupe and claim share a snapshot.** Never split into two round trips. If the
   implementation drifts to a read-then-write pattern across transactions, the
   project's entire thesis is falsified by its own code.
3. **A blocked agent learns who holds the key.** Returning a bare failure forces the
   agent to poll. Returning the holder and its intent lets the agent reason about an
   alternative, which is where the throughput gain comes from.
4. **A deduped agent receives the prior outcome**, not just a rejection. That is what
   turns arbitration into memory.

`DEDUPE_THRESHOLD` default `0.28` cosine distance. `[OPEN]` The right value is
empirical. The implementer should sweep it over the benchmark corpus and report a
precision and recall curve in `bench/results/threshold-sweep.md`. Publishing that
curve is itself a credibility artifact.

### 4.3 CLOSE — commit outcome, finding and release together

```sql
BEGIN;

UPDATE intents
   SET status = $status,          -- 'done' | 'abandoned'
       outcome = $outcome,
       tokens_spent = $tokens,
       closed_at = now()
 WHERE id = $iid AND repo_id = $repo;

INSERT INTO action_ledger (repo_id, intent_id, idempotency_key, action, payload_digest)
VALUES ($repo, $iid, $idem, $action, $digest)
ON CONFLICT (repo_id, idempotency_key) DO NOTHING;

DELETE FROM claims WHERE repo_id = $repo AND intent_id = $iid;

COMMIT;
```

The finding is deliberately **not** written here. It is produced asynchronously by
consolidation, so a slow embedding call never sits on the agent's critical path.

### 4.4 CONSOLIDATE — episodic to semantic, off the critical path

Triggered by a CockroachDB changefeed on `intents` filtered to rows transitioning to
`done`. The consumer embeds the outcome, then either reinforces an existing finding
or inserts a new one.

```sql
-- executed by the consolidation Lambda
WITH candidate AS (
  SELECT id, embedding <=> $emb AS dist
  FROM findings
  WHERE repo_id = $repo
  ORDER BY embedding <=> $emb
  LIMIT 1
)
-- if dist < 0.20 -> reinforce:
UPDATE findings
   SET corroborations = corroborations + 1,
       confidence = least(1.0, confidence + 0.1),
       last_confirmed_at = now()
 WHERE id = $existing_id;
-- else -> insert a new finding
```

This is the mechanism that makes the memory improve over time rather than merely
accumulate. Name it in the video: **consolidation**.

## 5. Concurrency handling

- Isolation is SERIALIZABLE. Every write transaction MUST be wrapped in a retry
  helper that catches SQLSTATE `40001` and retries with exponential backoff plus
  jitter, capped at five attempts.
- The retry counter MUST be exported as a metric and displayed in the demo UI.
  Showing that serialization conflicts happen and are handled is more persuasive than
  pretending they do not occur.
- Claim acquisition MUST NOT wait on a contested key. Losing fast and re-planning is
  the desired behaviour; blocking turns the fleet into a queue.
- `[OPEN]` Whether `SELECT ... FOR UPDATE` is needed anywhere. The current design
  avoids it entirely by relying on primary-key conflicts. If the implementer finds a
  case that requires it, document why in a code comment; it is a design smell here.

## 6. Time travel, as a bounded feature

`AS OF SYSTEM TIME` reconstructs what the fleet believed at any past instant, which
powers a "why did agent 4 stand down?" panel.

**Constraint:** on the free tier the garbage-collection window for deleted values is
roughly an hour and a quarter, so historical queries cannot reach further back than
that. `[VERIFY]` on the actual cluster.

Consequence for the design: time travel is a **demo feature only**. The durable audit
trail is the append-only `intents` table, which is not subject to that window. Do not
present `AS OF SYSTEM TIME` as the compliance story, or an informed judge will catch
the gap. Present it as what it is: a cheap, elegant read of recent history.

## 7. Retention and cost control

- `claims`: TTL via `expires_at`, swept every minute.
- `intents`: add a second TTL on closed rows at 30 days once the table is large
  enough to matter. Not needed for the hackathon; mention it in the README as the
  production path.
- `findings`: never expires. Confidence decays instead, via the consolidation job.
- Free-tier budget: the demo dataset MUST stay under a few hundred megabytes.

### Demo session scopes

The hosted demo writes as `cortex_demo`, not as `cortex_writer`. See
`04-ARCHITECTURE.md` §3 for why the principals are separate. In data terms:

- Each demo session MUST receive its own `repo_id`, distinct from any real
  repository's, so that isolation rests on the same index prefix that isolates
  tenants rather than on a `WHERE` clause the demo path could forget.
- Demo rows MUST carry a TTL and be reclaimed automatically. No manual cleanup
  between now and 2026-09-15.
- The demo write path MUST enforce a per-session row cap. Reaching it makes that
  session read-only; it MUST NOT produce an error, and it MUST NOT affect any other
  session. See the degradation ladder in `04-ARCHITECTURE.md` §5.
- `cortex_demo` MUST NOT be able to write outside a live demo session scope. This is
  an invariant, not a convention, and it has a test in §8.

## 8. What must be tested

Write these as the first tests, before any agent code exists.

1. Two concurrent claims on the same key: exactly one wins, the loser learns the holder.
2. Overlapping multi-key claims: no agent ends up with a partial set.
3. Glob versus file overlap is detected.
4. A retried close with the same idempotency key applies the effect once.
5. An expired claim is reclaimed and the key becomes acquirable.
6. Dedupe fires on a paraphrase of an in-flight intent and returns its holder.
7. A forced `40001` is retried and eventually commits.
8. Recall scoped to repo A never returns rows belonging to repo B.
9. The `cortex_demo` principal cannot write to a `repo_id` that is not a live demo
   session scope, and cannot read or write another session's rows. Assert against the
   real principal with its real grants; asserting against application code proves
   nothing, because the point of the separate principal is that it holds when the
   application code is wrong.
