-- Migration 022: Chain engine (M10 — v1.3 Phase 1)
-- Date: 2026-04-24
-- Context: chain-and-escalation §5 (data model), §6 (flows) +
--          chain-definition-format v1.0 (schema). Introduces sequential chain
--          runs of reviews where approval of step N materialises step N+1.
--
-- Two new tables + three columns on `reviews`:
--   * `chain_runs`  — the run header (mode, rejection_policy, status).
--   * `chain_steps` — one row per step in the definition, keyed by
--                     (chain_run_id, step_number). Each step's `review_id`
--                     is null until materialised.
--   * `reviews.chain_run_id`   — back-pointer for chain-aware list queries.
--   * `reviews.chain_step_id`  — back-pointer to the owning step row.
--   * `reviews.prev_step_ids`  — JSONB array of prior review IDs in the
--                                chain (empty array on step 1). Used to
--                                compose the chain transcript for the
--                                `chain.completed` / `chain.rejected` webhook.
--
-- Notes for the operator:
--   * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction; drizzle-kit
--     applies statements individually so `pnpm --filter @gatewerk/db push`
--     handles this. Raw psql runners should split on `;`.
--   * `IF NOT EXISTS` keeps the migration idempotent across reruns.
--   * In OSS v1.3 only `mode='sequential'` and `rejection_policy='terminate'`
--     are exercised by the engine, but the columns accept the full enum set
--     so Cloud builds can extend without an additional migration.

CREATE TABLE IF NOT EXISTS chain_runs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id       TEXT REFERENCES templates(id) ON DELETE SET NULL,
  name              TEXT,
  mode              TEXT NOT NULL DEFAULT 'sequential',
  rejection_policy  TEXT NOT NULL DEFAULT 'terminate',
  status            TEXT NOT NULL DEFAULT 'active',
  metadata          JSONB,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at      TIMESTAMPTZ
);

-- Active-only partial index: the engine's routing queries (dashboards, cloud
-- queue aggregations) always filter to active runs; terminal runs are
-- immutable and typically fetched by id only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS chain_runs_active_idx
  ON chain_runs (project_id, created_at DESC)
  WHERE status = 'active';

CREATE INDEX CONCURRENTLY IF NOT EXISTS chain_runs_project_id_idx
  ON chain_runs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chain_steps (
  id                TEXT PRIMARY KEY,
  chain_run_id      TEXT NOT NULL REFERENCES chain_runs(id) ON DELETE CASCADE,
  step_number       INTEGER NOT NULL,
  review_id         TEXT REFERENCES reviews(id) ON DELETE SET NULL,
  assignee_spec     JSONB NOT NULL,
  depends_on        JSONB,
  status            TEXT NOT NULL DEFAULT 'pending',
  materialized_at   TIMESTAMPTZ,
  UNIQUE (chain_run_id, step_number)
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS chain_steps_chain_run_id_idx
  ON chain_steps (chain_run_id, step_number);

-- `reviews` back-pointers. All nullable because the vast majority of reviews
-- are not part of a chain; the partial index on `chain_run_id` keeps the
-- chain-context lookup cheap.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS chain_run_id   TEXT REFERENCES chain_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chain_step_id  TEXT REFERENCES chain_steps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prev_step_ids  JSONB;

CREATE INDEX CONCURRENTLY IF NOT EXISTS reviews_chain_run_id_idx
  ON reviews (chain_run_id)
  WHERE chain_run_id IS NOT NULL;
