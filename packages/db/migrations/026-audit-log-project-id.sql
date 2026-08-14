-- Migration 026: audit_log.project_id for cloud-readiness tenant isolation (B2)
-- Date: 2026-04-29
-- Context: Production-readiness security audit (2026-04-29) Phase 4 P2.
-- audit_log had no project_id column. GET /api/v1/audit returned all rows
-- in the table with no per-project filter. OSS single-project: benign.
-- Cloud cutover: cross-org audit log leak (a project A admin would see
-- project B's audit entries).
--
-- Approach:
--   1) Add project_id TEXT (NULLABLE in this migration — see HARDENING below).
--   2) Index for the per-project list query.
--   3) Backfill from related resource tables via correlated subqueries,
--      one UPDATE per resource_type observed in production:
--        review       → reviews.project_id
--        template     → templates.project_id
--        chain_run    → chain_runs.project_id
--        chain_step   → chain_runs.project_id (joined via chain_steps)
--        api_key      → api_keys.project_id
--      System-level rows or rows whose resource has been deleted stay NULL;
--      the route filter treats NULL as visible to all (admin-only audit
--      surface).
--
-- Idempotent: ALTER TABLE / CREATE INDEX use IF NOT EXISTS. UPDATEs guard
-- on `project_id IS NULL` so re-running this migration is a no-op once the
-- backfill has settled (subsequent runs find nothing to update).
--
-- HARDENING (FOLLOW-UP, NOT THIS MIGRATION): once a prod audit confirms zero
-- orphan rows (`SELECT count(*) FROM audit_log WHERE project_id IS NULL` is
-- known and intentional), a future migration can:
--   - Set project_id NOT NULL after a sweep that resolves or deletes orphans.
--   - Add a foreign key to projects(id) ON DELETE CASCADE / SET NULL.
-- Both are deferred so this migration is safely re-runnable on partial-state
-- prod data (e.g., `chain_step` rows where the parent chain_run was deleted).
--
-- M0 pipeline applies this on next prod deploy.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS project_id TEXT;

CREATE INDEX IF NOT EXISTS audit_log_project_id_idx
  ON audit_log (project_id);

-- review → reviews.project_id
UPDATE audit_log
   SET project_id = (
     SELECT r.project_id
       FROM reviews r
      WHERE r.id = audit_log.resource_id
   )
 WHERE resource_type = 'review'
   AND resource_id IS NOT NULL
   AND project_id IS NULL;

-- template → templates.project_id
UPDATE audit_log
   SET project_id = (
     SELECT t.project_id
       FROM templates t
      WHERE t.id = audit_log.resource_id
   )
 WHERE resource_type = 'template'
   AND resource_id IS NOT NULL
   AND project_id IS NULL;

-- chain_run → chain_runs.project_id
UPDATE audit_log
   SET project_id = (
     SELECT cr.project_id
       FROM chain_runs cr
      WHERE cr.id = audit_log.resource_id
   )
 WHERE resource_type = 'chain_run'
   AND resource_id IS NOT NULL
   AND project_id IS NULL;

-- chain_step → chain_runs.project_id (via chain_steps.chain_run_id)
UPDATE audit_log
   SET project_id = (
     SELECT cr.project_id
       FROM chain_steps cs
       JOIN chain_runs cr ON cr.id = cs.chain_run_id
      WHERE cs.id = audit_log.resource_id
   )
 WHERE resource_type = 'chain_step'
   AND resource_id IS NOT NULL
   AND project_id IS NULL;

-- api_key → api_keys.project_id
UPDATE audit_log
   SET project_id = (
     SELECT ak.project_id
       FROM api_keys ak
      WHERE ak.id = audit_log.resource_id
   )
 WHERE resource_type = 'api_key'
   AND resource_id IS NOT NULL
   AND project_id IS NULL;

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback; run top-to-bottom to reverse this migration cleanly)
-- -----------------------------------------------------------------------------
-- DROP INDEX IF EXISTS audit_log_project_id_idx;
-- ALTER TABLE audit_log DROP COLUMN IF EXISTS project_id;
