CREATE TABLE IF NOT EXISTS product_feedback (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  context    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_feedback_subject_created_idx
  ON product_feedback (subject, created_at);

-- RLS with zero policies: not reachable from the anon-key auto-API,
-- same rationale as 090_enable_rls_notification_slack_email_tables.sql.
ALTER TABLE product_feedback ENABLE ROW LEVEL SECURITY;

-- DOWN
-- ALTER TABLE product_feedback DISABLE ROW LEVEL SECURITY;
-- DROP INDEX IF EXISTS product_feedback_subject_created_idx;
-- DROP TABLE IF EXISTS product_feedback;
