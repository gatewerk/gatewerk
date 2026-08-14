-- 064 — add plan_id, entitlements_override, trial_ends_at, seat_count to projects
-- Idempotent: every statement uses IF NOT EXISTS / column-existence guards.
-- community default means existing self-hosted rows get no feature walls.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'community';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS entitlements_override jsonb DEFAULT NULL;

-- Cloud-only. Null for OSS installs. Populated by provisioning on sign-up.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz DEFAULT NULL;

-- Populated by webhook-worker when plan changes; enforced by seat-enforcement helper.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS seat_count int NOT NULL DEFAULT 1;

-- Index so entitlement lookups by plan_id are O(log n).
CREATE INDEX IF NOT EXISTS idx_projects_plan_id ON projects (plan_id);

-- Constraint: plan_id must be one of the canonical SKUs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_plan_id'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_plan_id
      CHECK (plan_id IN ('community', 'team', 'business'));
  END IF;
END$$;
