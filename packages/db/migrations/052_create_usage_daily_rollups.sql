CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  rollup_date     DATE NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(organization_id, event_type, rollup_date)
);

CREATE INDEX IF NOT EXISTS usage_daily_rollups_org_date_idx
  ON usage_daily_rollups(organization_id, rollup_date);
