-- Migration 015: Perf composite indexes for inbox + templates list queries
-- Date: 2026-04-17
-- Context: Content Loading Architecture spec, PR 1 / Chunk 4.
--
-- Adds covering composite indexes for the most common list query shapes,
-- and drops indexes that are now redundant prefixes of the new composites.
--
-- Notes for the operator:
--   * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. If your
--     migration runner wraps each file in BEGIN/COMMIT, run this file
--     manually with `psql -f` (the SQL itself contains no transactional
--     statements). The runner used by `pnpm --filter @gatewerk/db push`
--     handles this correctly because drizzle-kit applies each statement
--     individually.
--   * `IF NOT EXISTS` keeps the migration idempotent across reruns.
--   * On the inbox list query, the actual ORDER BY is `CASE priority …, created_at DESC`,
--     so the trailing `created_at DESC` column primarily helps when the
--     priority bucket collapses to a single value (e.g. only `normal` exists).
--     The (project_id, status) prefix is the load-bearing part for filter
--     selectivity; the trailing column is a covering optimization.

-- Inbox list, default filter "WHERE project_id = $1 AND status = 'pending' ORDER BY priority, created_at DESC"
CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_project_id_status_created_at_idx
  ON reviews (project_id, status, created_at DESC);

-- Inbox list, filtered by template
CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_project_id_template_slug_created_at_idx
  ON reviews (project_id, template_slug, created_at DESC);

-- Inbox list, filtered by assignee (column is `assignee`, not `assigned_to`)
CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_project_id_assignee_created_at_idx
  ON reviews (project_id, assignee, created_at DESC);

-- Templates list, default filter "WHERE project_id = $1 AND status = 'active' ORDER BY created_at DESC"
CREATE INDEX CONCURRENTLY IF NOT EXISTS templates_project_id_status_created_at_idx
  ON templates (project_id, status, created_at DESC);

-- Drop the (project_id, status) index — now a redundant prefix of the new composite above.
-- Spec named this `reviews_project_status`; the actual Drizzle-generated name is
-- `reviews_project_id_status_idx`. We use the actual name here.
DROP INDEX CONCURRENTLY IF EXISTS reviews_project_id_status_idx;

-- Drop the (project_id) index — now a redundant prefix of templates_project_id_status_created_at_idx.
-- Not called out by the spec but symmetric with the reviews change above; the schema declaration
-- has been updated to remove it as well.
DROP INDEX CONCURRENTLY IF EXISTS templates_project_id_idx;
