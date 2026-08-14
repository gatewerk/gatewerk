-- Migration 017: API key security hardening — expiration + IP allowlist
-- Date: 2026-04-17
-- Context: Integration Surface spec, Phase 3 (items 7 + 9).
--
-- Adds two optional columns on `api_keys`:
--   * expires_at   — nullable; when set and in the past, middleware rejects with 401 key_expired.
--   * ip_allowlist — nullable; when non-null the request IP must match an entry (exact or CIDR),
--                    otherwise middleware rejects with 401 ip_not_allowed.
--
-- Storage choice for ip_allowlist is jsonb, matching the existing scopes + template_ids columns
-- in this table. The rest of the codebase treats jsonb string arrays as `string[]` via Drizzle
-- `.$type<string[]>()`, and the PG text[] vs jsonb[string] difference has no functional impact at
-- our scale (a key realistically has ≤10 entries). Keeping it jsonb avoids adding a new storage
-- pattern for a single column.
--
-- The partial index on expires_at is there so a future sweeper (e.g. a "notify at ≤7 days remaining"
-- cron) stays fast — at steady state most keys will have expires_at IS NULL.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ip_allowlist JSONB;

CREATE INDEX IF NOT EXISTS api_keys_expires_at_idx
  ON api_keys (expires_at)
  WHERE expires_at IS NOT NULL;
