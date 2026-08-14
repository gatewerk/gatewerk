CREATE TABLE IF NOT EXISTS slack_user_links (
  reviewer_id   TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  cached_at     TIMESTAMPTZ DEFAULT NOW()
);

-- DOWN
-- DROP TABLE IF EXISTS slack_user_links;
