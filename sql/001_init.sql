-- 001_init.sql
-- CORTEX initial schema. Apply after 000_verify.sql passes.
-- Authoritative source: spec/03-MEMORY-MODEL.md section 2.
-- If this file and the spec disagree, the spec wins and this file is a bug.

SET CLUSTER SETTING feature.vector_index.enabled = true;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS repos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       STRING NOT NULL UNIQUE,          -- 'owner/name'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A demo session scope is a repo like any other, with an expiry. NULL means a real
-- repository; a timestamp means a sandbox scope created by the hosted demo, per
-- spec/03-MEMORY-MODEL.md section 7. This single column is what every row-level
-- security policy below predicates on, so it is the whole confinement boundary.
--
-- ADD COLUMN IF NOT EXISTS, because U1's done-when is that this file re-applies to a
-- live cluster without error and that property is not negotiable for one column.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;

-- The NAIVE arm's shared work state, and nothing else's. NULL on every real repository
-- and on every CORTEX run, per spec/06-BENCHMARK-SPEC.md section 2: "Shared state: JSON
-- file on disk, last-write-wins."
--
-- This is the database analogue of that file, and it is here rather than in one of the
-- four memory tiers on purpose. It is not memory — it is the thing the naive fleet uses
-- INSTEAD of memory, and putting it in `findings` or `intents` would have made the
-- contrast a difference in how one table is used rather than a difference in kind. It
-- also would not have fitted: both of those require a VECTOR(1024) this has no meaning
-- for, and a fake finding would surface in the demo's own semantic-memory panel.
--
-- On `repos` specifically: the demo session's scope row is already where a session's own
-- demo-only state lives (demo_expires_at, directly above), it is one row per session, it
-- carries the same row-level security policy as everything else, and it is NOT in the
-- changefeed's watch list — so the naive arm writes real rows without inventing change
-- events for a panel that has nothing to show them in.
--
-- One whole-cell column rather than a row per entry, deliberately. The losses the naive
-- arm demonstrates come from reading a snapshot, working, and writing the whole snapshot
-- back over whatever landed in between. A row per entry would be an append, which does
-- not lose writes and would not be last-write-wins.
ALTER TABLE repos ADD COLUMN IF NOT EXISTS demo_shared_state JSONB;

CREATE TABLE IF NOT EXISTS agents (
  id           STRING PRIMARY KEY,            -- 'agent-3'
  repo_id      UUID NOT NULL REFERENCES repos(id),
  kind         STRING NOT NULL,               -- external | scripted
  session_id   UUID NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('external', 'scripted'))
);

-- ---------------------------------------------------------------------
-- WORKING MEMORY
-- The uniqueness of (repo_id, resource_key) IS the mutual exclusion.
-- There is deliberately no separate lock object to fall out of sync.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS claims (
  repo_id      UUID NOT NULL,
  resource_key STRING NOT NULL,               -- file:… | glob:… | migration:… | service:…
  intent_id    UUID NOT NULL,
  holder       STRING NOT NULL,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo_id, resource_key),
  INDEX claims_by_intent (repo_id, intent_id)
) WITH (
  ttl_expiration_expression = 'expires_at',
  ttl_job_cron = '*/1 * * * *'
);

-- ---------------------------------------------------------------------
-- EPISODIC MEMORY
-- Append-only. Rows transition, they are never deleted.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS intents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id       UUID NOT NULL,
  agent_id      STRING NOT NULL,
  statement     STRING NOT NULL,
  resource_keys STRING[] NOT NULL,
  embedding     VECTOR(1024) NOT NULL,
  status        STRING NOT NULL DEFAULT 'proposed',
  deduped_of    UUID NULL,
  outcome       JSONB NULL,
  tokens_spent  INT8 NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ NULL,
  -- vector_cosine_ops, not the default vector_l2_ops: every recall, dedupe and
  -- consolidation query in spec/03-MEMORY-MODEL.md orders by <=>, and an L2 index
  -- cannot serve a cosine ordering. Verified on the cluster — with the default
  -- opclass the planner silently falls back to FULL SCAN. See V1 in
  -- docs/verification-log.md.
  VECTOR INDEX intents_semantic (repo_id, embedding vector_cosine_ops),
  INDEX intents_by_status (repo_id, status, created_at DESC),
  CHECK (status IN ('proposed', 'in_flight', 'done', 'abandoned', 'deduped'))
);

-- ---------------------------------------------------------------------
-- SEMANTIC MEMORY
-- Never expires. Confidence decays instead, via consolidation.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS findings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id           UUID NOT NULL,
  fact              STRING NOT NULL,
  embedding         VECTOR(1024) NOT NULL,
  source_intent_id  UUID NULL,
  confidence        FLOAT8 NOT NULL DEFAULT 0.5,
  corroborations    INT8 NOT NULL DEFAULT 1,
  contradictions    INT8 NOT NULL DEFAULT 0,
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  VECTOR INDEX findings_semantic (repo_id, embedding vector_cosine_ops),
  CHECK (confidence >= 0.0 AND confidence <= 1.0)
);

-- ---------------------------------------------------------------------
-- PROCEDURAL MEMORY
-- The unique idempotency key is what makes a retried tool call safe.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL,
  intent_id       UUID NOT NULL,
  idempotency_key STRING NOT NULL,
  action          STRING NOT NULL,
  payload_digest  STRING NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, idempotency_key)
);

-- ---------------------------------------------------------------------
-- COST CONTROL — spec/04-ARCHITECTURE.md section 5, brake 2.
--
-- NOT a memory tier, and the only table in this file that is not. section 2 defines six
-- tables and they are the memory model; this is a seventh, added deliberately in U17 with
-- Julian's decision on 2026-08-12 rather than assumed, because section 5 requires "a run
-- counter in CockroachDB, default 40 LIVE runs per day globally" and there is nowhere in
-- the memory model for a global counter to live.
--
-- Global is the operative word, and it is why this table has no repo_id. Invariant 5 —
-- every read carries WHERE repo_id — exists to stop one tenant's memory reaching another
-- through a forgotten filter. There is no tenant here to leak: the table holds a date and
-- a count and nothing else, which test/live-budget.test.ts asserts against
-- information_schema so that the exemption cannot quietly widen when someone adds a
-- column. A per-tenant counter would also not be the brake section 5 specifies — every
-- anonymous visitor mints a fresh scope, so a per-scope cap would cap nothing.
--
-- No TTL. One row per day is the record of what was spent, 365 rows a year is nothing,
-- and section 5's brake is worth more with its history intact than reclaimed.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS live_run_budget (
  day        DATE PRIMARY KEY DEFAULT current_date,
  runs_used  INT8 NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (runs_used >= 0)
);

-- ---------------------------------------------------------------------
-- Privilege planes. Create the service accounts in the Cloud Console first,
-- then run these grants. The reader must never gain a write verb.
-- ---------------------------------------------------------------------

GRANT SELECT ON TABLE repos, agents, claims, intents, findings, action_ledger
  TO cortex_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE repos, agents, claims, intents, findings, action_ledger
  TO cortex_writer;

-- live_run_budget is deliberately absent from the reader grant above. The read plane is
-- the agents' recall path and the budget is not memory; nothing on that plane reads it,
-- so it is not granted. test/privilege-planes.test.ts asserts the refusal, because "we
-- did not grant it" and "it is refused" are different claims and only one is checkable.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE live_run_budget TO cortex_writer;

-- The demo plane may spend the budget and may not erase it. No DELETE, on purpose: a
-- principal that can delete today's row can reset the brake that governs it, which makes
-- the cap advisory. UPDATE is confined to today by the policy further down.
GRANT SELECT, INSERT, UPDATE ON TABLE live_run_budget TO cortex_demo;

-- ---------------------------------------------------------------------
-- The demo plane: table grants, then row-level security to take most of them back.
--
-- spec/04-ARCHITECTURE.md section 3's [OPEN] is CLOSED (2026-08-11, V24): demo-scoped
-- repo_ids in the one cluster, confined by RLS rather than by a second cluster.
--
-- Why RLS and not a plain grant: section 3 requires real repository memory to be
-- UNREACHABLE to this principal, not merely filtered out of its queries. A table-level
-- grant gives it the whole table and leaves confinement resting on application code
-- being correct — which is precisely the assumption section 3 refuses to make, since
-- the point of a separate principal is that it holds when the application is wrong.
--
-- Why not a second cluster: it doubles the surface of the longevity risk that
-- 08-BUILD-PLAN.md section 7 already ranks as the most likely way this submission
-- fails AFTER submission, and it makes the one-cluster architecture claim false.
--
-- Verified by attempting the statements against this cluster before being written
-- here, never by reading a catalogue. V9 is why: SHOW GRANTS answered a narrow
-- question truthfully while three accounts held admin through a role membership.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE repos, agents, claims, intents, findings, action_ledger
  TO cortex_demo;

-- FORCE, not merely ENABLE. ENABLE exempts the table owner, and every one of these
-- tables is owned by the account that ran this file. Without FORCE the policies below
-- would be silently inert for the owner and the test would still pass for cortex_demo,
-- which is the shape of a guard that protects everything except the thing you check.
ALTER TABLE repos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos         FORCE  ROW LEVEL SECURITY;
ALTER TABLE agents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents        FORCE  ROW LEVEL SECURITY;
ALTER TABLE claims        ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims        FORCE  ROW LEVEL SECURITY;
ALTER TABLE intents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE intents       FORCE  ROW LEVEL SECURITY;
ALTER TABLE findings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings      FORCE  ROW LEVEL SECURITY;
ALTER TABLE action_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_ledger FORCE  ROW LEVEL SECURITY;
ALTER TABLE live_run_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_run_budget FORCE  ROW LEVEL SECURITY;

-- DROP-then-CREATE on every policy below, not CREATE ... IF NOT EXISTS. IF NOT EXISTS
-- silently skips when a policy of that name already exists, so editing a predicate here
-- would apply cleanly to a fresh cluster and do nothing at all to a live one — the
-- migration would report success while the cluster kept the old rule. This file must
-- converge, not merely avoid erroring. Found the hard way: the session-scope condition
-- was added to these predicates and the first re-run applied none of it.
--
-- Enabling RLS with no policy denies everything to non-exempt roles, so the reader and
-- writer planes need policies that restore exactly what their grants already say. These
-- are permissive-everything for those two roles: RLS is not the mechanism confining
-- them, their grants are, and 04 section 3's security claim rests on cortex_reader
-- holding no write verb.
DROP POLICY IF EXISTS reader_all ON repos;
CREATE POLICY reader_all ON repos         FOR ALL TO cortex_reader USING (true);
DROP POLICY IF EXISTS reader_all ON agents;
CREATE POLICY reader_all ON agents        FOR ALL TO cortex_reader USING (true);
DROP POLICY IF EXISTS reader_all ON claims;
CREATE POLICY reader_all ON claims        FOR ALL TO cortex_reader USING (true);
DROP POLICY IF EXISTS reader_all ON intents;
CREATE POLICY reader_all ON intents       FOR ALL TO cortex_reader USING (true);
DROP POLICY IF EXISTS reader_all ON findings;
CREATE POLICY reader_all ON findings      FOR ALL TO cortex_reader USING (true);
DROP POLICY IF EXISTS reader_all ON action_ledger;
CREATE POLICY reader_all ON action_ledger FOR ALL TO cortex_reader USING (true);

DROP POLICY IF EXISTS writer_all ON repos;
CREATE POLICY writer_all ON repos         FOR ALL TO cortex_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS writer_all ON agents;
CREATE POLICY writer_all ON agents        FOR ALL TO cortex_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS writer_all ON claims;
CREATE POLICY writer_all ON claims        FOR ALL TO cortex_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS writer_all ON intents;
CREATE POLICY writer_all ON intents       FOR ALL TO cortex_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS writer_all ON findings;
CREATE POLICY writer_all ON findings      FOR ALL TO cortex_writer USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS writer_all ON action_ledger;
CREATE POLICY writer_all ON action_ledger FOR ALL TO cortex_writer USING (true) WITH CHECK (true);

-- The other five tables predicate on the repo their repo_id names, and reaching another
-- table from a policy needs a function.
--
-- CockroachDB policy expressions cannot contain a subquery. Both obvious spellings were
-- attempted against this cluster and both were refused:
--   EXISTS (SELECT 1 FROM repos r WHERE r.id = claims.repo_id ...)  -> 42P01
--   repo_id IN (SELECT id FROM repos WHERE ...)                     -> 42703
-- The expression is parsed against the policy's own table and no other data source is
-- in scope, so the FROM clause is never processed. A STABLE function is the way through,
-- and it is a better shape anyway: the predicate is named once and every policy below
-- reads as the sentence 04 section 3 actually specifies.
--
-- Not LEAKPROOF: this cluster requires a leakproof function to be IMMUTABLE, and this
-- one reads a table and calls now(), so it is neither.
--
-- TWO conditions, because section 3 states two invariants and they are not the same one:
--
--   1. the row's repo is a demo scope that has not expired  — keeps cortex_demo off real
--      repository memory. This is the boundary that matters most and it is enforced by
--      the principal's policies, so it holds even when the application is wrong.
--   2. the row's repo is THE SESSION'S scope             — keeps one demo session out of
--      another's rows, which section 3 also requires and which condition 1 alone does
--      not give: every visitor connects as the same SQL user.
--
-- Condition 2 reads a per-connection setting the demo write path sets before touching
-- anything. Be precise about what that is worth: with one shared SQL user there is no
-- stronger option — you cannot create a SQL role per anonymous visitor — so this is
-- defence at the write path and not at the account boundary, and section 3's own
-- ordering puts session-versus-session below real-memory for exactly that reason.
-- What it does buy is that it **fails closed**: `current_setting(..., true)` returns
-- NULL when unset, the predicate is false, and a statement that forgot to scope itself
-- reads and writes nothing. Per V5 the failure mode that matters is a forgotten filter
-- failing OPEN, and this is the same class of mistake made to fail shut.
CREATE OR REPLACE FUNCTION is_current_demo_scope(rid UUID) RETURNS BOOL
  LANGUAGE SQL STABLE AS $$
    SELECT rid::STRING = current_setting('cortex.demo_session', true)
       AND EXISTS (SELECT 1 FROM repos
                    WHERE repos.id = rid
                      AND repos.demo_expires_at IS NOT NULL
                      AND repos.demo_expires_at > now())
  $$;

GRANT EXECUTE ON FUNCTION is_current_demo_scope(UUID) TO cortex_demo;

-- The demo plane. `repos` predicates on its own row; the other five call the function.
--
-- USING governs which rows are visible to SELECT, UPDATE and DELETE; WITH CHECK governs
-- which rows may be written by INSERT and UPDATE. Both are required and they are not the
-- same statement: USING alone would let the demo UPDATE a row it can see INTO a scope it
-- cannot, and WITH CHECK alone would let it read everything.
--
-- `demo_expires_at > now()` means an expired scope becomes unreachable at the instant it
-- expires, before any TTL job runs. Reclamation is then housekeeping rather than the
-- security boundary, which is the right order for a demo that must survive unattended
-- until 2026-09-15.
-- `repos` spells the predicate out inline rather than calling the function, because
-- the function reads `repos` and calling it from this table's own policy is a recursion
-- waiting to happen. Same two conditions, written against the row's own columns.
DROP POLICY IF EXISTS demo_scope ON repos;
CREATE POLICY demo_scope ON repos FOR ALL TO cortex_demo
  USING      (demo_expires_at IS NOT NULL AND demo_expires_at > now()
              AND id::STRING = current_setting('cortex.demo_session', true))
  WITH CHECK (demo_expires_at IS NOT NULL AND demo_expires_at > now()
              AND id::STRING = current_setting('cortex.demo_session', true));

DROP POLICY IF EXISTS demo_scope ON agents;
CREATE POLICY demo_scope ON agents FOR ALL TO cortex_demo
  USING      (is_current_demo_scope(repo_id))
  WITH CHECK (is_current_demo_scope(repo_id));

DROP POLICY IF EXISTS demo_scope ON claims;
CREATE POLICY demo_scope ON claims FOR ALL TO cortex_demo
  USING      (is_current_demo_scope(repo_id))
  WITH CHECK (is_current_demo_scope(repo_id));

DROP POLICY IF EXISTS demo_scope ON intents;
CREATE POLICY demo_scope ON intents FOR ALL TO cortex_demo
  USING      (is_current_demo_scope(repo_id))
  WITH CHECK (is_current_demo_scope(repo_id));

DROP POLICY IF EXISTS demo_scope ON findings;
CREATE POLICY demo_scope ON findings FOR ALL TO cortex_demo
  USING      (is_current_demo_scope(repo_id))
  WITH CHECK (is_current_demo_scope(repo_id));

DROP POLICY IF EXISTS demo_scope ON action_ledger;
CREATE POLICY demo_scope ON action_ledger FOR ALL TO cortex_demo
  USING      (is_current_demo_scope(repo_id))
  WITH CHECK (is_current_demo_scope(repo_id));

-- The cost-control table. Its policy is the one narrow exception to everything above:
-- cortex_demo reaches a row that is not in a demo session scope, because section 5's
-- counter is global and a per-session counter would cap nothing.
--
-- The exception is bounded to one row — today's. The principal cannot read what earlier
-- days spent, cannot rewrite them, and (having no DELETE grant) cannot remove any of it.
-- So the widest thing a compromised demo path can do here is spend today's budget, which
-- is the budget it was already authorised to spend, and the failure resolves to REPLAY
-- rather than to an error page or to a bill.
--
-- Bare `current_date` rather than a function call: verified against this cluster before
-- being written here. Policy expressions on this cluster cannot contain a subquery (see
-- is_current_demo_scope above), but a built-in like this one parses and evaluates fine.
DROP POLICY IF EXISTS writer_all ON live_run_budget;
CREATE POLICY writer_all ON live_run_budget FOR ALL TO cortex_writer
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS demo_today ON live_run_budget;
CREATE POLICY demo_today ON live_run_budget FOR ALL TO cortex_demo
  USING      (day = current_date)
  WITH CHECK (day = current_date);

-- Do NOT verify any of the above with SHOW GRANTS or SHOW POLICIES. The guard is
-- test/privilege-planes.test.ts, which attempts every statement and requires the
-- cluster to refuse it. A catalogue answers the question you asked, not the one you
-- meant — see V9.
