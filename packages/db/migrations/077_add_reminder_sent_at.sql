ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

-- DOWN
-- ALTER TABLE reviews DROP COLUMN IF EXISTS reminder_sent_at;
