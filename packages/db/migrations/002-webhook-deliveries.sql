-- Migration: 002-webhook-deliveries
-- Date: 2026-03-11
-- Description: Add webhook_deliveries table for retry tracking

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  url TEXT NOT NULL,
  payload JSONB NOT NULL,
  hmac_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_webhook_deliveries_status_next ON webhook_deliveries(status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX idx_webhook_deliveries_review_id ON webhook_deliveries(review_id);
