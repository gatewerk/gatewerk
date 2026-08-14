-- Migration 009: Template status column + token_version for session invalidation
-- Date: 2026-03-29

-- 1. Templates: add status column (draft/active/inactive lifecycle)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- 2. Reviewers: add token_version for session invalidation on password change
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
