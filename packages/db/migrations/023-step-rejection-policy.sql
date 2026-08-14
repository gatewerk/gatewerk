-- Migration 023: Per-step rejection policy on chain_steps (M13 — v1.3 Phase 5)
-- Date: 2026-04-24
-- Context: chain-and-escalation §6.3 (rejection policies) generalised from the
-- chain-level setting shipped in M10 to a per-step disposition. Each step can
-- opt into one of three behaviours when the step's review is rejected:
--
--   * 'abort'    — terminate the chain (equivalent to M10 rejection_policy='terminate')
--   * 'continue' — advance to the next step as if approved
--   * 'branch'   — jump back to an earlier step (`rejection_branch_to`, 1-based
--                  step_number, must precede the current step to avoid cycles)
--
-- When `rejection_policy IS NULL` the engine defaults to 'abort' so pre-M13
-- chain_steps rows (no value stored) retain the M10 terminate-on-reject
-- behaviour. This preserves backward compatibility — the column is additive.
--
-- The branch-to-step invariant (`rejection_branch_to < step_number`) is
-- enforced both by zod at createRun time and by a DB CHECK constraint below
-- so mis-authored JSON / direct DB writes can't create cycles.
--
-- Notes for the operator:
--   * `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` keep the
--     migration idempotent across reruns.
--   * No data backfill required — NULL is the correct value for existing
--     rows (they pre-date M13 and rely on the chain-level rejection_policy).
--   * Down migration (block at bottom, commented) drops the columns + checks
--     in reverse order. Run manually when rolling back M13.

ALTER TABLE chain_steps
  ADD COLUMN IF NOT EXISTS rejection_policy    TEXT,
  ADD COLUMN IF NOT EXISTS rejection_branch_to INTEGER;

-- Drop-then-add keeps the CHECK idempotent (Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`).
ALTER TABLE chain_steps
  DROP CONSTRAINT IF EXISTS chain_steps_rejection_policy_values_chk;
ALTER TABLE chain_steps
  ADD CONSTRAINT chain_steps_rejection_policy_values_chk
  CHECK (
    rejection_policy IS NULL
    OR rejection_policy IN ('abort', 'continue', 'branch')
  );

-- Composite invariant: `rejection_branch_to` must be set iff policy = 'branch',
-- and the target must be a prior step (`< step_number`). Step 1 can never use
-- 'branch' because there is no earlier step to branch to — enforced here
-- (step_number = 1 → rejection_branch_to < 1 is unsatisfiable for a positive
-- integer).
ALTER TABLE chain_steps
  DROP CONSTRAINT IF EXISTS chain_steps_rejection_branch_to_chk;
ALTER TABLE chain_steps
  ADD CONSTRAINT chain_steps_rejection_branch_to_chk
  CHECK (
    (rejection_policy <> 'branch' AND rejection_branch_to IS NULL)
    OR (
      rejection_policy = 'branch'
      AND rejection_branch_to IS NOT NULL
      AND rejection_branch_to > 0
      AND rejection_branch_to < step_number
    )
  );

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback; run top-to-bottom to reverse this migration cleanly)
-- -----------------------------------------------------------------------------
-- ALTER TABLE chain_steps
--   DROP CONSTRAINT IF EXISTS chain_steps_rejection_branch_to_chk;
-- ALTER TABLE chain_steps
--   DROP CONSTRAINT IF EXISTS chain_steps_rejection_policy_values_chk;
-- ALTER TABLE chain_steps
--   DROP COLUMN IF EXISTS rejection_branch_to,
--   DROP COLUMN IF EXISTS rejection_policy;
