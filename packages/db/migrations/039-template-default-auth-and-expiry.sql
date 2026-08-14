-- Migration 039: template default_auth_level + default_expiry_seconds.
-- Spec section 8.5. Pre-fills ShareViaLinkDialog from template-level defaults
-- so reviewers don't have to re-pick auth tier and expiry on every link.
-- Idempotent (IF NOT EXISTS) per gatewerk migration corpus convention.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS default_auth_level TEXT NOT NULL DEFAULT 'public';

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS default_expiry_seconds INTEGER NOT NULL DEFAULT 86400;

-- CHECK constraints mirror server-side Zod enum + range. Defense-in-depth:
-- if a future code path bypasses route-layer validation, storage layer
-- still enforces. Range upper bound 2592000s = 30 days, matching spec
-- section 8.5 editor presets (24h, 7d, 30d). Per-link overrides via
-- ShareViaLinkDialog can go up to 720h = 30 days (existing cap).
--
-- DO-block guard: Postgres pre-18 lacks ADD CONSTRAINT IF NOT EXISTS for
-- table-level CHECK; pg_constraint lookup makes the migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_default_auth_level_check'
  ) THEN
    ALTER TABLE templates ADD CONSTRAINT templates_default_auth_level_check
      CHECK (default_auth_level IN ('public', 'email_otp', 'account'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_default_expiry_seconds_check'
  ) THEN
    ALTER TABLE templates ADD CONSTRAINT templates_default_expiry_seconds_check
      CHECK (default_expiry_seconds > 0 AND default_expiry_seconds <= 2592000);
  END IF;
END $$;
