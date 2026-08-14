-- Migration: Prefixed IDs + suggested/approved value
-- Date: 2026-03-11
-- Description: Adds suggested_value and approved_value to reviews
--              ID migration from UUID to TEXT is handled by drizzle-kit push
--              on fresh installs. For existing data, manual migration required.
--
-- For existing production data with UUID IDs:
-- 1. Run drizzle-kit push to update column types
-- 2. Run a data migration script to add gw_ prefixes to existing IDs
-- 3. Update all foreign key references

-- Add new columns to reviews (safe for existing data)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS suggested_value JSONB;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS approved_value JSONB;

-- Backfill suggested_value from payload for existing reviews
UPDATE reviews SET suggested_value = payload WHERE suggested_value IS NULL;

-- Backfill approved_value for decided reviews
UPDATE reviews SET approved_value = COALESCE(edited_payload, payload)
WHERE status = 'decided' AND approved_value IS NULL;
