ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_paused_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_pause_reason TEXT;

-- DOWN
-- ALTER TABLE organizations DROP COLUMN IF EXISTS email_pause_reason;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS email_paused_at;
