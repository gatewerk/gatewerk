-- Migration 020: api_keys.scopes grandfather-branch removal (NOT NULL)
--
-- Before this migration, api_keys.scopes was nullable. A NULL row meant
-- "grandfather this legacy key to all scopes" per migration 003's intent —
-- but that "silent allow" branch lives at `apps/api/src/policy/can.ts:12`
-- and `packages/mcp/src/server.ts:25` and is indistinguishable in the API
-- from an explicitly full-access key. A future operator can revoke scopes
-- on a key by PATCHing an empty array; they can't revoke "NULL means all"
-- without rotating the key. That's a footgun.
--
-- Fix strategy:
--   1. Backfill any NULL rows with an explicit ALL_SCOPES array (preserves
--      legacy key behavior exactly — pre-migration-003 keys were de-facto
--      all-scoped, and stay all-scoped here). No privilege change for any
--      existing caller.
--   2. Self-assert zero NULL rows remain.
--   3. SET NOT NULL — the grandfather branch becomes unreachable; the
--      TS compiler plus the removed branch enforce the invariant.
--
-- The scope list below is the snapshot of `packages/shared/src/enums.ts`
-- SCOPES at 2026-04-21. This migration is one-time; a later SCOPES addition
-- does NOT re-run this backfill (by design — existing keys have already
-- been backfilled, and new keys must specify scopes explicitly).

UPDATE api_keys
SET scopes = '[
  "reviews:create",
  "reviews:read",
  "reviews:decide",
  "templates:read",
  "templates:write",
  "feedback:read",
  "audit:read",
  "stats:read"
]'::jsonb
WHERE scopes IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_keys WHERE scopes IS NULL) THEN
    RAISE EXCEPTION 'Migration 020: backfill incomplete — NULL scopes rows remain';
  END IF;
END $$;

ALTER TABLE api_keys ALTER COLUMN scopes SET NOT NULL;
