CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  reviewer_id  TEXT NOT NULL,
  review_id    TEXT REFERENCES reviews(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  dedup_key    TEXT NOT NULL,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_reviewer_id_created_at_idx ON notifications (reviewer_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_key_idx ON notifications (dedup_key);

-- DOWN
-- DROP TABLE IF EXISTS notifications;
