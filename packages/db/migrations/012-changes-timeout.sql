-- Add changes_timeout_hours to templates
-- When a review is in changes_requested status longer than this, auto-revert to pending
ALTER TABLE templates ADD COLUMN IF NOT EXISTS changes_timeout_hours integer;
