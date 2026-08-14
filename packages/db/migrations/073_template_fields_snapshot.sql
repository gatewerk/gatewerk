-- Migration 073: P8 field-schema snapshot (spec 2026-07-10 §4.1; lifecycle map §0.1).
-- reviews.template_fields: normalized field schema captured at creation so
-- template re-publish/delete never changes how an in-flight review renders.
-- Nullable — legacy rows fall back to the live template join.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS template_fields JSONB;

-- Backfill NON-TERMINAL reviews from their current template (best-effort
-- honesty for in-flight rows; decided/expired/archived keep the live-join
-- fallback to avoid a full-table rewrite).
UPDATE reviews r
SET template_fields = t.fields
FROM templates t
WHERE r.template_id = t.id
  AND r.template_fields IS NULL
  AND r.status IN ('pending', 'awaiting_iteration', 'awaiting_external', 'monitoring');

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback)
-- -----------------------------------------------------------------------------
-- ALTER TABLE reviews DROP COLUMN IF EXISTS template_fields;
