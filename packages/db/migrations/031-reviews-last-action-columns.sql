-- Migration 031: add last_action_* columns to reviews
-- Phase: configurable-actions Phase 1 (additive)
--
-- Adds four columns surfacing the most recent action context per review so the
-- inbox can render badges like "Awaiting after 'Escalate' by Idris 2h ago"
-- without joining the audit log on every render. last_action_kind is bounded
-- by a CHECK to the canonical ACTION_KINDS set (decision | iteration |
-- side_effect) per spec §4.6; NULL is permitted because backfill (migration
-- 032) only populates decided rows.
--
-- Idempotent: IF NOT EXISTS guards on column adds; DROP IF EXISTS + recreate
-- on the named CHECK constraint.

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS last_action_id text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS last_action_kind text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS last_action_at timestamp with time zone;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS last_action_by text;

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_last_action_kind_chk;
ALTER TABLE reviews ADD CONSTRAINT reviews_last_action_kind_chk
  CHECK (last_action_kind IS NULL OR last_action_kind IN ('decision', 'iteration', 'side_effect'));
