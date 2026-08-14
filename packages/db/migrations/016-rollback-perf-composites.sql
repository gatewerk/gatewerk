-- Migration 016: Rollback for 015-perf-composite-indexes.sql
-- Date: 2026-04-17
-- Status: PREEMPTIVE — apply only if 015 measurably regresses staging perf.
--
-- This file is intentionally NOT auto-applied. To roll back:
--   psql "$STAGING_DATABASE_URL" -f packages/db/migrations/016-rollback-perf-composites.sql
--
-- After running this rollback, also revert the schema declarations in
--   packages/db/src/schema/reviews.ts
--   packages/db/src/schema/templates.ts
-- to the pre-015 state so `drizzle-kit generate` doesn't re-propose the
-- composite indexes on the next run.

-- 1. Drop the composites added by 015.
DROP INDEX CONCURRENTLY IF EXISTS reviews_project_id_status_created_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS reviews_project_id_template_slug_created_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS reviews_project_id_assignee_created_at_idx;
DROP INDEX CONCURRENTLY IF EXISTS templates_project_id_status_created_at_idx;

-- 2. Recreate the prefix indexes that 015 dropped.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_project_id_status_idx
  ON reviews (project_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS templates_project_id_idx
  ON templates (project_id);
