-- 059 — create jobs.daily_digest_state singleton row
-- idempotency. The row is locked with SELECT … FOR UPDATE inside the digest
-- job handler so the date-comparison + dispatch + last_run_at write happen
-- in one transaction. Idempotent CREATE / INSERT / ALTER patterns so a
-- partial deploy that re-runs the migration apply pipeline is a no-op.

CREATE TABLE IF NOT EXISTS jobs_daily_digest_state (
  id text PRIMARY KEY CHECK (id = 'singleton'),
  last_run_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz
);

ALTER TABLE jobs_daily_digest_state ADD COLUMN IF NOT EXISTS
  last_run_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z'::timestamptz;

INSERT INTO jobs_daily_digest_state (id) VALUES ('singleton')
ON CONFLICT (id) DO NOTHING;
