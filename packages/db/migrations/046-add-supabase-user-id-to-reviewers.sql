-- 046-add-supabase-user-id-to-reviewers.sql
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS supabase_user_id TEXT UNIQUE;
