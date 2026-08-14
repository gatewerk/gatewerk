-- Migration 072: HOTL monitoring gate (spec 2026-07-02).
-- reviews.oversight: 'blocking' (default — agent waits) | 'monitoring'
-- (agent already acted; human may veto/confirm within the expires_at window).
-- templates.allow_monitoring: human-authored opt-in — monitoring requests
-- against templates without this flag are refused at creation (4xx).
-- -----------------------------------------------------------------------------

-- reviews.oversight — controls whether the requesting agent is blocking
-- (waiting for a decision) or has already acted and is monitoring for a
-- veto/confirm within the expires_at window.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS oversight TEXT NOT NULL DEFAULT 'blocking';

-- templates.allow_monitoring — per-template opt-in. Agents may request
-- oversight='monitoring' ONLY against templates with this flag on. Default
-- FALSE — a lying agent needs a complicit human, not just a label.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS allow_monitoring BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'reviews'
      AND constraint_name = 'reviews_oversight_chk'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_oversight_chk
      CHECK (oversight IN ('blocking', 'monitoring'));
  END IF;
END $$;

-- Extend the status CHECK (name established in migration 033; Postgres
-- requires DROP + ADD to change an existing CHECK). The value list MUST
-- mirror REVIEW_STATUSES in packages/shared/src/enums.ts exactly.
-- Last defined in migration 035 with six values; adding 'monitoring'.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_chk;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_chk
  CHECK (status IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived', 'monitoring'));

-- Extend the decision CHECK (name established in migration 028, last
-- extended in 070). Mirrors DECISIONS in packages/shared/src/enums.ts.
-- Last defined in migration 070 with six values; adding 'confirmed', 'vetoed'.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_decision_chk;
ALTER TABLE reviews ADD CONSTRAINT reviews_decision_chk
  CHECK (
    decision IS NULL OR decision IN (
      'approved', 'rejected', 'edited', 'retried', 'expired',
      'max_iterations_reached', 'confirmed', 'vetoed'
    )
  );

-- Worker claim query for the monitoring branch: status = 'monitoring' AND
-- expires_at <= NOW(). reviews_expires_at_idx already covers the range scan;
-- a partial status index is not warranted at expected monitoring volumes.

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback)
-- -----------------------------------------------------------------------------
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_decision_chk;
-- ALTER TABLE reviews ADD CONSTRAINT reviews_decision_chk
--   CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'edited', 'retried', 'expired', 'max_iterations_reached'));
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_chk;
-- ALTER TABLE reviews ADD CONSTRAINT reviews_status_chk
--   CHECK (status IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived'));
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_oversight_chk;
-- ALTER TABLE reviews DROP COLUMN IF EXISTS oversight;
-- ALTER TABLE templates DROP COLUMN IF EXISTS allow_monitoring;
