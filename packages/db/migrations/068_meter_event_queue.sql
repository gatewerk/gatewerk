-- 068 — durable queue for Stripe Billing Meter events.
-- Stripe does NOT retry on 400-class responses; persistent failures must
-- be replayed by Gatewerk's retry worker (ee/jobs/meter-retry.ts).
-- Idempotency: idempotency_key is unique; duplicate enqueues are no-ops.

CREATE TABLE IF NOT EXISTS meter_event_queue (
  id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  value NUMERIC NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_meter_event_queue_pending
  ON meter_event_queue(status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_meter_event_queue_customer
  ON meter_event_queue(stripe_customer_id, created_at);
