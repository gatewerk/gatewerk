CREATE TABLE IF NOT EXISTS notification_preferences (
  reviewer_id TEXT PRIMARY KEY,
  prefs       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DOWN
-- DROP TABLE IF EXISTS notification_preferences;
