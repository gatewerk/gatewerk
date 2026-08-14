ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS login_notifications BOOLEAN NOT NULL DEFAULT TRUE;
