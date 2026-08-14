-- Migration 010: Add opened_at to review_tokens for grace period
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
