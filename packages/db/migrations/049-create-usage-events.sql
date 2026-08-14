-- 049-create-usage-events.sql
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS usage_events_org_type_date_idx
  ON usage_events (organization_id, event_type, counted_at);
