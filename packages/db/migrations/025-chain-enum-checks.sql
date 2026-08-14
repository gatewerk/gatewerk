-- Migration 025: CHECK constraints on chain + review enum columns (C1)
-- Date: 2026-04-28
-- Context: Production-readiness data-integrity audit (2026-04-29) P2.
-- chain_runs.status, chain_runs.mode, chain_runs.rejection_policy,
-- chain_steps.status, and reviews.status are all TEXT NOT NULL with no DB
-- CHECK constraint. Values are app-controlled by zod schemas in
-- @gatewerk/shared (enums.ts + api/schemas/{chains,reviews}.ts) and the
-- chain engine. Production data verified clean 2026-04-29 pre-migration:
--
--   chain_runs.status            ∈ {active, rejected}                         (clean)
--   chain_runs.mode              ∈ {sequential}                               (clean)
--   chain_runs.rejection_policy  ∈ {terminate}                                (clean)
--   chain_steps.status           ∈ {pending, active, rejected}                (clean)
--   reviews.status               ∈ {pending, decided, archived}               (clean)
--
-- This migration is defense-in-depth against:
--   * Direct SQL writes (ops/maintenance scripts that bypass zod).
--   * Schema-drift-during-mode-extension (Cloud will introduce parallel/mixed
--     chain modes; without a CHECK, a typo in a migration that adds new values
--     could silently land junk in prod).
--
-- Canonical value sets are sourced from the zod schemas (the app-side source
-- of truth) — not from observed prod data — so future-reserved values like
-- `aborted`, `parallel`, `mixed`, `back_one`, `restart`, `completed`,
-- `approved`, `expired`, `skipped`, `superseded`, `changes_requested` remain
-- accepted by the CHECK even though they are not yet written by OSS code.
--
-- Idempotent: every constraint follows the standard
-- `DROP CONSTRAINT IF EXISTS … ; ADD CONSTRAINT …` pattern (Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`). Safe to re-run; matches the idiom in
-- migration 023.
--
-- M0 pipeline applies this on next prod deploy. Down migration is the
-- commented block at the bottom.

-- chain_runs.status: zod ChainRunObjectSchema.status (packages/shared/src/api/schemas/chains.ts)
ALTER TABLE chain_runs
  DROP CONSTRAINT IF EXISTS chain_runs_status_chk;
ALTER TABLE chain_runs
  ADD CONSTRAINT chain_runs_status_chk
  CHECK (status IN ('active', 'completed', 'rejected', 'aborted'));

-- chain_runs.mode: zod ChainModeSchema (packages/shared/src/api/schemas/chains.ts).
-- OSS edition gates non-`sequential` at the zod layer (V13 feature_not_in_edition);
-- Cloud will write `parallel`/`mixed`. CHECK accepts the full set so the same
-- migration is correct in both editions without branching.
ALTER TABLE chain_runs
  DROP CONSTRAINT IF EXISTS chain_runs_mode_chk;
ALTER TABLE chain_runs
  ADD CONSTRAINT chain_runs_mode_chk
  CHECK (mode IN ('sequential', 'parallel', 'mixed'));

-- chain_runs.rejection_policy: zod RejectionPolicySchema (packages/shared/src/api/schemas/chains.ts).
-- `back_one`/`restart` are deprecated but still in the schema enum (M13 amended
-- §6.3 to per-step policy on chain_steps); kept here for historical compat.
ALTER TABLE chain_runs
  DROP CONSTRAINT IF EXISTS chain_runs_rejection_policy_chk;
ALTER TABLE chain_runs
  ADD CONSTRAINT chain_runs_rejection_policy_chk
  CHECK (rejection_policy IN ('terminate', 'back_one', 'restart'));

-- chain_steps.status: zod ChainStepObjectSchema.status (packages/shared/src/api/schemas/chains.ts).
-- Engine writes pending/active/approved/rejected today; expired/skipped/superseded
-- are reserved for timeout/dependency-skip flows landing in later milestones.
ALTER TABLE chain_steps
  DROP CONSTRAINT IF EXISTS chain_steps_status_chk;
ALTER TABLE chain_steps
  ADD CONSTRAINT chain_steps_status_chk
  CHECK (status IN ('pending', 'active', 'approved', 'rejected', 'expired', 'skipped', 'superseded'));

-- reviews.status: REVIEW_STATUSES (packages/shared/src/enums.ts).
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_status_chk;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_status_chk
  CHECK (status IN ('pending', 'changes_requested', 'decided', 'expired', 'archived'));

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback; run top-to-bottom to reverse this migration cleanly)
-- -----------------------------------------------------------------------------
-- ALTER TABLE reviews
--   DROP CONSTRAINT IF EXISTS reviews_status_chk;
-- ALTER TABLE chain_steps
--   DROP CONSTRAINT IF EXISTS chain_steps_status_chk;
-- ALTER TABLE chain_runs
--   DROP CONSTRAINT IF EXISTS chain_runs_rejection_policy_chk;
-- ALTER TABLE chain_runs
--   DROP CONSTRAINT IF EXISTS chain_runs_mode_chk;
-- ALTER TABLE chain_runs
--   DROP CONSTRAINT IF EXISTS chain_runs_status_chk;
