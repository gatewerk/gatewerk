-- Add connection management columns to api_keys
-- Existing keys get sensible defaults (backward compatible)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS callback_url TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS default_reviewer TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_hour INTEGER;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS template_ids JSONB;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS description TEXT;
