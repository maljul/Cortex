-- 000_verify.sql
-- Run this BEFORE writing any code, in the CockroachDB Cloud Console SQL shell.
-- Paste one block at a time and record the result in docs/verification-log.md.
-- Every block has a fallback documented in spec/04-ARCHITECTURE.md section 8.

-- =====================================================================
-- V1 — Vector indexing with a prefix column
-- The single most important check. The whole recall path depends on it.
-- =====================================================================

SET CLUSTER SETTING feature.vector_index.enabled = true;

CREATE TABLE _v1 (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope UUID NOT NULL,
  e     VECTOR(4),
  -- Must match the operator the query uses below. The default is vector_l2_ops,
  -- which serves <-> but NOT <=>; with the default this check full-scans while
  -- still returning correct rows, which is the failure mode this block exists to
  -- catch. The schema orders by <=> throughout, so the index is cosine.
  VECTOR INDEX (scope, e vector_cosine_ops)
);

INSERT INTO _v1 (scope, e) VALUES
  ('00000000-0000-0000-0000-000000000001', '[1,0,0,0]'),
  ('00000000-0000-0000-0000-000000000001', '[0.9,0.1,0,0]'),
  ('00000000-0000-0000-0000-000000000001', '[0,0,0,1]'),
  ('00000000-0000-0000-0000-000000000002', '[1,0,0,0]');

-- Expect: two rows from scope 1, nearest first. The scope-2 row must NOT appear.
SELECT id, e <=> '[1,0,0,0]' AS dist
FROM _v1
WHERE scope = '00000000-0000-0000-0000-000000000001'
ORDER BY e <=> '[1,0,0,0]'
LIMIT 3;

-- Expect: the plan mentions the vector index, not a full scan.
EXPLAIN SELECT id FROM _v1
WHERE scope = '00000000-0000-0000-0000-000000000001'
ORDER BY e <=> '[1,0,0,0]' LIMIT 3;

-- PASTE BOTH OUTPUTS INTO docs/verification-log.md BEFORE CONTINUING.

-- =====================================================================
-- V4 — Row-level TTL (do this before dropping anything)
-- Working memory reclamation depends on it.
-- =====================================================================

CREATE TABLE _v4 (
  k          STRING PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
) WITH (ttl_expiration_expression = 'expires_at', ttl_job_cron = '*/1 * * * *');

-- Expect: the storage parameters appear in the output.
SHOW CREATE TABLE _v4;

INSERT INTO _v4 VALUES ('already-expired', now() - INTERVAL '1 hour');
-- Wait two minutes, then expect zero rows.
SELECT count(*) FROM _v4;

-- =====================================================================
-- V2 — Changefeed with a webhook sink
-- Get a throwaway URL from webhook.site first and paste it below.
-- =====================================================================

CREATE TABLE _v2 (id INT PRIMARY KEY, v STRING);

-- If this errors on licensing or cluster tier, record the exact message and
-- switch to the scheduler-polling fallback. Do not spend more than 20 minutes here.
CREATE CHANGEFEED FOR TABLE _v2
  INTO 'webhook-https://REPLACE-ME.webhook.site/xxxx?insecure_tls_skip_verify=true'
  WITH updated, resolved = '10s';

INSERT INTO _v2 VALUES (1, 'hello');
-- Expect a payload to arrive at the webhook URL within seconds.

-- Second option, streams to this session instead of a sink.
-- Useful to know whether it works even if you end up using the sink form.
-- EXPERIMENTAL CHANGEFEED FOR _v2;

-- =====================================================================
-- V3 — Historical query window
-- Determines whether the time-travel panel survives. It is optional either way.
-- =====================================================================

SELECT count(*) FROM _v2 AS OF SYSTEM TIME '-30s';
SELECT count(*) FROM _v2 AS OF SYSTEM TIME '-30m';
-- Expect one of these to fail with a GC-threshold error. Record which, and the
-- exact boundary. That boundary is the demo's rewind limit.
SELECT count(*) FROM _v2 AS OF SYSTEM TIME '-2h';

-- =====================================================================
-- Cleanup
-- =====================================================================

DROP TABLE IF EXISTS _v1;
DROP TABLE IF EXISTS _v2;
DROP TABLE IF EXISTS _v4;
