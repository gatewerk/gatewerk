CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  is_transactional BOOLEAN NOT NULL DEFAULT TRUE,
  bounced_at TIMESTAMPTZ,
  complained_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_sends_message_id_idx ON email_sends (message_id);
CREATE INDEX IF NOT EXISTS email_sends_org_created_at_idx ON email_sends (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_sends_address_created_at_idx ON email_sends (address, created_at DESC);

-- DOWN
-- DROP INDEX IF EXISTS email_sends_address_created_at_idx;
-- DROP INDEX IF EXISTS email_sends_org_created_at_idx;
-- DROP INDEX IF EXISTS email_sends_message_id_idx;
-- DROP TABLE IF EXISTS email_sends;
