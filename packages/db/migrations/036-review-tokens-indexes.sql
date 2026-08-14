-- Migration 036: review_tokens query indexes
-- Phase: Token Redesign Phase 1 (additive perf)
--
-- Adds two composite indexes on review_tokens supporting Phase 2 UI queries
-- and expiry handling:
--
-- 1. (review_id, created_at DESC) — supports the tokens history panel
--    (per-review chronological listing, spec §8.3).
-- 2. (project_id, expires_at) — supports per-project expiry scans / "tokens
--    approaching expiry" queries. Spec §10.3 wrote this as "(project_id,
--    status, expires_at)" but review_tokens has no status column — that
--    leading would be a no-op or a join. Dropping it; the composite on the
--    two existing columns serves the spec's documented intent.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS for both.

CREATE INDEX IF NOT EXISTS review_tokens_review_id_created_at_idx
  ON review_tokens (review_id, created_at DESC);

CREATE INDEX IF NOT EXISTS review_tokens_project_id_expires_at_idx
  ON review_tokens (project_id, expires_at);
