-- Migration 038: account-tier tokens require non-null auth_user_id.
--
-- The auth_level='account' branch in the recipient-flow handler
-- compares session.id !== tokenRecord.auth_user_id. If auth_user_id is
-- NULL on a legitimately-created account-tier token, the comparison
-- always succeeds and emits a misleading account_mismatch audit.
-- Defense-in-depth at the storage layer: reject misconfigured rows
-- at INSERT/UPDATE time so the bug class is surfaced loudly in dev/CI
-- rather than silently in prod.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.

ALTER TABLE review_tokens DROP CONSTRAINT IF EXISTS review_tokens_account_requires_user_id_chk;
ALTER TABLE review_tokens ADD CONSTRAINT review_tokens_account_requires_user_id_chk
  CHECK (auth_level <> 'account' OR auth_user_id IS NOT NULL);
