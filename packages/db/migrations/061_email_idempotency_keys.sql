-- Email idempotency store: prevents duplicate sends across process restarts.
-- Key is composite "${to}:${idempotencyKey}" (same logic as the in-memory
-- store in services/email/index.ts). TTL enforced by a periodic cleanup job
-- (or pg-boss cron) that deletes rows older than 24h.
-- Idempotent: safe to re-apply.
CREATE TABLE IF NOT EXISTS email_idempotency_keys (
  id            TEXT        PRIMARY KEY,
  message_id    TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_idempotency_keys_created_at_idx
  ON email_idempotency_keys (created_at);
