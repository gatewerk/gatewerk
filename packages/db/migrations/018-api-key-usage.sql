-- Migration 018: api_key_usage — per-request logging for API keys
-- Date: 2026-04-18
-- Context: Integration Surface spec, Phase 4 (items 6 + 8). See spec §5 for the
-- rationale behind a dedicated table (not audit_events): data-class mismatch,
-- 1000× volume difference, divergent query patterns, conflicting retention.
--
-- Row shape is minimal by design — endpoint + method + status_code + timestamp
-- are enough for the aggregations the spec commits to (requests_today, rate-limit %,
-- 24h 1h-bucketed sparkline, last-N recent). Anything richer (payload size, latency)
-- can be added as a non-breaking column later.
--
-- The covering index (api_key_id, created_at DESC) is the single load-bearing index:
-- every aggregation filters by api_key_id and orders/windows on created_at. Spec
-- targets p95 < 100ms on 10k req/day — trivially met with this index shape.
--
-- FK ON DELETE CASCADE: deleting a key cleans up its usage rows in the same
-- transaction. Avoids orphaned telemetry dangling after key rotation/teardown.
--
-- pg_cron 30-day TTL is scheduled conditionally: if pg_extension already lists
-- pg_cron, we register the sweep. Otherwise the DO block is a no-op and the TTL
-- is handled out-of-band (manual DELETE or a node-level scheduler). This keeps
-- the migration runnable on self-hosted / pglite / test environments where
-- pg_cron isn't installed. CREATE EXTENSION is intentionally NOT attempted here
-- because it requires superuser and managed Postgres vendors whitelist it
-- differently — installation is an ops decision, scheduling is the migration's job.

CREATE TABLE IF NOT EXISTS api_key_usage (
  id          BIGSERIAL PRIMARY KEY,
  api_key_id  TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  method      TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_key_usage_lookup
  ON api_key_usage (api_key_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'api_key_usage_ttl',
      '0 3 * * *',
      'DELETE FROM api_key_usage WHERE created_at < NOW() - INTERVAL ''30 days'''
    );
  END IF;
END $$;
