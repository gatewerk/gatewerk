ALTER TABLE slack_user_links ADD COLUMN IF NOT EXISTS lookup_failed_at TIMESTAMPTZ;

-- DOWN
-- ALTER TABLE slack_user_links DROP COLUMN IF EXISTS lookup_failed_at;
