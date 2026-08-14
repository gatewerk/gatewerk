-- Migration 035: awaiting_external status + email_otp_codes table
-- Phase: Token Redesign Phase 1 (additive)
--
-- Adds 'awaiting_external' to reviews_status_chk supporting the state where
-- an external recipient holds an active token. Also creates email_otp_codes
-- table for Phase 3 email OTP auth tier (table is unused in Phase 1; landed
-- now to keep all storage shape for the redesign in one phase boundary).
-- Status transitions onto / off of awaiting_external are wired in C4; auth
-- tier flows in Phase 3 (roadmap §1.5).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT for the CHECK widen;
-- CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS.

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_chk;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_chk
  CHECK (status IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived'));

CREATE TABLE IF NOT EXISTS email_otp_codes (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES review_tokens(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_otp_codes_token_id_idx ON email_otp_codes(token_id);
