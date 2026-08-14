CREATE TABLE IF NOT EXISTS notification_suppressions (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_suppressions_address_idx ON notification_suppressions (address);

-- DOWN
-- DROP TABLE IF EXISTS notification_suppressions;
