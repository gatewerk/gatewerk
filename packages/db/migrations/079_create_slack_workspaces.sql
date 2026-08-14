CREATE TABLE IF NOT EXISTS slack_workspaces (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL,
  team_name                TEXT,
  bot_token_encrypted      TEXT NOT NULL,
  bot_user_id              TEXT,
  installed_by_reviewer_id TEXT,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  revoked_at               TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_workspaces_team_id_idx ON slack_workspaces (team_id);

-- DOWN
-- DROP TABLE IF EXISTS slack_workspaces;
