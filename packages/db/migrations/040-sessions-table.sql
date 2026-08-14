CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  reviewer_id    TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  jti            TEXT NOT NULL UNIQUE,
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_reviewer_active
  ON sessions (reviewer_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_jti
  ON sessions (jti) WHERE revoked_at IS NULL;
