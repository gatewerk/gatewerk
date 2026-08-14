-- Migration 019: project HMAC secret hardening (NOT NULL)
--
-- Before this migration, projects.hmac_secret was nullable. Five callsites
-- silently substituted `config.hmacSecret` (env var) when a project row had
-- NULL — so a leaked env secret would impersonate every NULL-secret project's
-- outgoing webhooks.
--
-- Fix strategy:
--   1. Backfill any NULL rows with a fresh 256-bit random hex string so every
--      project owns its own distinct HMAC.
--   2. Self-assert zero NULL rows remain (fail loud if the backfill missed one).
--   3. SET NOT NULL — the TS compiler then enforces removal of the ||-fallback
--      at every callsite once drizzle schema regens.
--
-- Randomness:
--   `gen_random_uuid()` is core Postgres 13+ (no extension required; same
--   "migrations do not CREATE EXTENSION" policy as 018). Two UUIDv4 values
--   concatenated with dashes stripped yields 64 hex chars carrying 244 bits
--   of RFC-4122-strong randomness — well above 128-bit HMAC-SHA256 targets.
--   Avoids the pgcrypto dependency that would complicate self-hosted /
--   managed-Postgres installs.

UPDATE projects
SET hmac_secret = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
WHERE hmac_secret IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE hmac_secret IS NULL) THEN
    RAISE EXCEPTION 'Migration 019: backfill incomplete — NULL hmac_secret rows remain';
  END IF;
END $$;

ALTER TABLE projects ALTER COLUMN hmac_secret SET NOT NULL;
