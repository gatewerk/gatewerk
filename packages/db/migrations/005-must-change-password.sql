-- Add must_change_password flag for forced password change on first login
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS must_change_password boolean DEFAULT false NOT NULL;
