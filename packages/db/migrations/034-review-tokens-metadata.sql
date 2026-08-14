-- Migration 034: review_tokens metadata columns
-- Phase: Token Redesign Phase 1 (additive)
--
-- Adds accountability metadata + auth-tier columns to review_tokens supporting
-- manual/chain/agent trigger paths and public/email_otp/account auth tiers.
-- Existing rows backfill via Postgres ADD COLUMN ... DEFAULT semantics. Defaults
-- are then dropped on the four columns that require API-supplied values
-- (purpose, recipient_label, created_by_kind, created_by_id). Phase 3 (auth tier
-- enforcement at /r/:token) is deferred; this migration only establishes the
-- storage shape.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + ADD
-- CONSTRAINT for named CHECKs; ALTER COLUMN DROP DEFAULT and SET NOT NULL
-- are no-ops on re-run.

ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT '(unspecified)';
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS recipient_label TEXT NOT NULL DEFAULT '(unspecified)';
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS auth_level TEXT NOT NULL DEFAULT 'public';
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS auth_email TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS auth_user_id TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS created_by_kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS created_by_id TEXT NOT NULL DEFAULT '(legacy)';
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS revoked_by TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS decided_by_email TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS decided_by_user_id TEXT;
ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;

-- Drop temporary backfill defaults on columns that need API-supplied values.
-- auth_level keeps 'public' default permanently per spec §4.1.
-- verification_attempts keeps 0 default permanently per spec §4.1.
ALTER TABLE review_tokens ALTER COLUMN purpose DROP DEFAULT;
ALTER TABLE review_tokens ALTER COLUMN recipient_label DROP DEFAULT;
ALTER TABLE review_tokens ALTER COLUMN created_by_kind DROP DEFAULT;
ALTER TABLE review_tokens ALTER COLUMN created_by_id DROP DEFAULT;

-- Named CHECKs for enum-typed columns.
ALTER TABLE review_tokens DROP CONSTRAINT IF EXISTS review_tokens_auth_level_chk;
ALTER TABLE review_tokens ADD CONSTRAINT review_tokens_auth_level_chk
  CHECK (auth_level IN ('public', 'email_otp', 'account'));

ALTER TABLE review_tokens DROP CONSTRAINT IF EXISTS review_tokens_created_by_kind_chk;
ALTER TABLE review_tokens ADD CONSTRAINT review_tokens_created_by_kind_chk
  CHECK (created_by_kind IN ('manual', 'chain', 'agent'));
