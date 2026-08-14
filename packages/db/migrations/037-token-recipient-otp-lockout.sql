-- Migration 037: token-level OTP lockout column on review_tokens.
--
-- When the email_otp recipient flow records 5 failed code submissions
-- against a token's active OTP row, this column is set to NOW() + 1 hour
-- and BOTH /request and /verify reject until the lock clears.
--
-- Lives on review_tokens rather than email_otp_codes by design: a fresh
-- /request creates a NEW email_otp_codes row, so a row-scoped lockout
-- would silently reset when the attacker requests a new code. Token-
-- scoped lockout survives the resend cycle.
--
-- Persists across process restarts (in-memory rate-limit alone would
-- lose this across deploys / OOM kills).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE review_tokens ADD COLUMN IF NOT EXISTS otp_locked_until TIMESTAMPTZ;
