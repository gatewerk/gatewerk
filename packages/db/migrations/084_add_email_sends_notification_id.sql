ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS notification_id TEXT;
CREATE INDEX IF NOT EXISTS email_sends_notification_id_idx ON email_sends (notification_id);

-- DOWN
-- DROP INDEX IF EXISTS email_sends_notification_id_idx;
-- ALTER TABLE email_sends DROP COLUMN IF EXISTS notification_id;
