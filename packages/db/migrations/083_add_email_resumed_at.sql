ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_resumed_at TIMESTAMPTZ;

-- DOWN
-- ALTER TABLE organizations DROP COLUMN IF EXISTS email_resumed_at;
