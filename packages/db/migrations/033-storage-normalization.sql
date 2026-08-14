-- Migration 033: storage normalization — UPDATE legacy 'changes_requested' rows + tighten CHECK
-- Phase: configurable-actions Phase 3 closure (Pieces 1-5)
--
-- Closes the additive transition opened by migration 030. Migration 030
-- WIDENED the CHECK to accept both 'changes_requested' AND 'awaiting_iteration'
-- so the new dispatcher could write canonical without breaking existing rows.
-- Phase 4 (commit 0588769 + d2d8514) flipped the WRITE paths to canonical.
-- Migration 033 normalizes any legacy rows still in storage and tightens
-- the CHECK to canonical-only. Storage shape becomes uniform; the API
-- filter-param alias (commit 46cce66) continues to accept 'changes_requested'
-- as a deprecated INPUT value for one minor version per spec §11.3, then is
-- removed in v2.0.
--
-- Idempotent: UPDATE is no-op on already-normalized DBs (the WHERE filters by
-- the legacy value); the CHECK uses DROP IF EXISTS + ADD per the project's
-- standard idiom (matches migrations 025 + 028 + 030).

BEGIN;

-- Step 1: normalize remaining legacy rows.
UPDATE reviews SET status = 'awaiting_iteration' WHERE status = 'changes_requested';

-- Step 2: tighten reviews_status_chk to canonical-only. 'changes_requested'
-- is no longer accepted at the storage layer.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_chk;

ALTER TABLE reviews ADD CONSTRAINT reviews_status_chk
  CHECK (status IN ('pending', 'awaiting_iteration', 'decided', 'expired', 'archived'));

COMMIT;
