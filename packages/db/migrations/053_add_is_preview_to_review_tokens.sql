-- Migration 053: Add is_preview column to review_tokens for temporary preview links.
-- Preview tokens render the recipient page but block the decide action,
-- and do NOT transition the review to awaiting_external.
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS is_preview boolean NOT NULL DEFAULT false;
