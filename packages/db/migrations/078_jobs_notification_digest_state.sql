-- Migration 078: notification digest idempotency state table
--
-- jobs_notification_digest_state is a single-row singleton gating the
-- daily notification digest job (oss.notification-digest pg-boss queue).
-- Mirrors jobs_daily_digest_state but uses a separate table so the two
-- digest jobs can gate independently without sharing a CHECK-constrained
-- singleton row.
CREATE TABLE IF NOT EXISTS jobs_notification_digest_state (
  id         TEXT PRIMARY KEY CHECK (id = 'singleton'),
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);

INSERT INTO jobs_notification_digest_state (id, last_run_at)
  VALUES ('singleton', '1970-01-01T00:00:00Z')
  ON CONFLICT (id) DO NOTHING;
