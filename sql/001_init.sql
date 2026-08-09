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
-- Privilege planes. Create the service accounts in the Cloud Console first,
-- then run these grants. The reader must never gain a write verb.
-- ---------------------------------------------------------------------

-- GRANT SELECT ON TABLE repos, agents, claims, intents, findings, action_ledger
--   TO cortex_reader;

-- GRANT SELECT, INSERT, UPDATE, DELETE
--   ON TABLE repos, agents, claims, intents, findings, action_ledger
--   TO cortex_writer;

-- Sanity check after granting. The reader must show SELECT only.
-- SHOW GRANTS ON TABLE claims;
