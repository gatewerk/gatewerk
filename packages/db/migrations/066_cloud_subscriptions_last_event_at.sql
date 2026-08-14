-- 066 — add last_event_at column for Stripe webhook event-ordering gate.
-- Stripe occasionally delivers webhooks out-of-order (e.g., subscription.updated
-- arriving after subscription.deleted due to retry queues). Without an ordering
-- gate, a stale UPDATE can re-grant gates on a canceled subscription.
-- Each handler compares incoming event.created with last_event_at and skips
-- mutation if the event is older. Idempotent via IF NOT EXISTS.

ALTER TABLE cloud_subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cloud_subscriptions_last_event_at
  ON cloud_subscriptions(last_event_at);
