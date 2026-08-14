-- Migration 028: CHECK constraints on remaining enum-shaped columns
-- Date: 2026-05-03
-- Context: Wave 4 P3 polish (production-readiness data-integrity follow-up
-- to migration 025). Migration 025 covered chain_runs / chain_steps /
-- reviews.status. This migration covers the remaining TEXT NOT NULL
-- columns whose values are app-controlled by zod schemas in
-- @gatewerk/shared but had no DB-level CHECK to defend against direct
-- SQL writes or schema-drift typos:
--
--   reviews.priority    ∈ PRIORITIES        (low, normal, high, critical)
--   reviews.decision    ∈ DECISIONS         (approved, rejected, edited, retried, expired)
--   reviewers.role      ∈ {admin, reviewer}
--   templates.status    ∈ TEMPLATE_STATUSES (draft, active, inactive)
--
-- Canonical value sets sourced from packages/shared/src/enums.ts and
-- packages/shared/src/index.ts (TEMPLATE_STATUSES). reviewers.role values
-- are sourced from the chain assignee zod schema
-- (packages/shared/src/api/schemas/chains.ts:36) and the requireRole
-- middleware call sites in apps/api/src/routes/.
--
-- reviews.decision is nullable until a review is decided; the CHECK uses
-- `IS NULL OR ...` so pending rows remain accepted. Other columns are
-- NOT NULL with defaults, so a straight IN (...) suffices.
--
-- Idempotent: every constraint follows the standard
-- `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` pattern (matches the
-- idiom in migration 025). Safe to re-run.

-- reviews.priority: PRIORITIES (packages/shared/src/enums.ts:1)
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_priority_chk;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_priority_chk
  CHECK (priority IN ('low', 'normal', 'high', 'critical'));

-- reviews.decision: DECISIONS (packages/shared/src/enums.ts:4). Nullable —
-- pending reviews carry decision = NULL. The IS NULL branch keeps the
-- migration applicable to existing data without backfill.
--
-- Pre-constraint normalization: legacy test/seed data on prod ~2026-05
-- carried 'approve' / 'reject' (singular, missing past-tense -d/-ed).
-- These predate the canonical DECISIONS set landing in shared/enums.ts.
-- Rewrite them to the canonical form so the CHECK below applies cleanly;
-- guarded by WHERE so the UPDATE is a no-op on environments without the
-- legacy values.
UPDATE reviews SET decision = 'approved' WHERE decision = 'approve';
UPDATE reviews SET decision = 'rejected' WHERE decision = 'reject';

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_decision_chk;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_decision_chk
  CHECK (
    decision IS NULL
    OR decision IN ('approved', 'rejected', 'edited', 'retried', 'expired')
  );

-- reviewers.role: TEXT NOT NULL DEFAULT 'reviewer'. OSS edition has two
-- roles; cloud may extend (e.g. owner, billing) via a future migration
-- that bumps the CHECK.
ALTER TABLE reviewers
  DROP CONSTRAINT IF EXISTS reviewers_role_chk;
ALTER TABLE reviewers
  ADD CONSTRAINT reviewers_role_chk
  CHECK (role IN ('admin', 'reviewer'));

-- templates.status: TEMPLATE_STATUSES (packages/shared/src/index.ts:135).
ALTER TABLE templates
  DROP CONSTRAINT IF EXISTS templates_status_chk;
ALTER TABLE templates
  ADD CONSTRAINT templates_status_chk
  CHECK (status IN ('draft', 'active', 'inactive'));

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback; run top-to-bottom to reverse this migration cleanly)
-- -----------------------------------------------------------------------------
-- ALTER TABLE templates
--   DROP CONSTRAINT IF EXISTS templates_status_chk;
-- ALTER TABLE reviewers
--   DROP CONSTRAINT IF EXISTS reviewers_role_chk;
-- ALTER TABLE reviews
--   DROP CONSTRAINT IF EXISTS reviews_decision_chk;
-- ALTER TABLE reviews
--   DROP CONSTRAINT IF EXISTS reviews_priority_chk;
