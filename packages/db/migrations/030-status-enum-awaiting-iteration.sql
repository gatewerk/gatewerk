-- Migration 030: status enum extension — add awaiting_iteration as canonical alongside changes_requested
-- Phase: configurable-actions Phase 1 (additive-only strategy per call-site footprint review 2026-05-05)
--
-- Adds 'awaiting_iteration' to reviews_status_chk WITHOUT removing 'changes_requested'.
-- Existing rows untouched. Storage normalization deferred to a later migration once all write
-- paths have migrated to canonical 'awaiting_iteration'. This decoupling lets Phase 1 ship
-- safely without coordinating ~20 call-site rewrites in the same deploy. Honors spec §11.2's
-- "alias for one minor version" promise.
--
-- Idempotent: DROP IF EXISTS + recreate.

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_chk;

ALTER TABLE reviews ADD CONSTRAINT reviews_status_chk
  CHECK (status IN ('pending', 'changes_requested', 'awaiting_iteration', 'decided', 'expired', 'archived'));
