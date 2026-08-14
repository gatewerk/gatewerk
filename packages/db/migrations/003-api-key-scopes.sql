-- Add scopes column to api_keys (JSONB array of scope strings)
-- Existing keys get NULL which means "all scopes" (backward compatible)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes JSONB;
