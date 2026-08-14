-- Migration 021: Assignment ladder on reviews (M9 — v1.3 Phase 1)
-- Date: 2026-04-23
-- Context: chain-and-escalation spec §3.4-5, §5.3 reviews additions, §6.2 flow.
--
-- Adds the three ladder columns that specialise `reviews.assignee` into an
-- ordered escalation ladder with timer-based promotion. The `TimeoutWorker`
-- gains a second claim query gated on `ladder_next_promote_at` (partial index
-- below). `created_at` is the anchor for cumulative `trigger_after_seconds`;
-- see `AssignmentLadderService` for the promotion arithmetic.
--
-- Notes for the operator:
--   * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. drizzle-kit
--     applies each statement individually so `pnpm --filter @gatewerk/db push`
--     handles this correctly; raw psql runners should split on `;`.
--   * `IF NOT EXISTS` keeps the migration idempotent across reruns.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS assignment_ladder       JSONB,
  ADD COLUMN IF NOT EXISTS ladder_index            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ladder_next_promote_at  TIMESTAMPTZ;

-- Sparse partial index: the ladder claim query filters on
-- `ladder_next_promote_at <= NOW()` and this column is NULL for every review
-- that either has no ladder or has reached its final step, so a partial index
-- keeps the candidate set tight (effectively the count of in-flight escalations,
-- not total reviews).
CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_ladder_next_promote_at_idx
  ON reviews (ladder_next_promote_at)
  WHERE ladder_next_promote_at IS NOT NULL;
