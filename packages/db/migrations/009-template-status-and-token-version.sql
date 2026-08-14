-- Migration 009: Template status column + reviewer token_version for session invalidation
-- Date: 2026-03-28
-- Context: template validation hardening + session invalidation on password change

-- 1. Templates: add status column (draft/active/inactive)
ALTER TABLE templates ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- 2. Reviewers: add token_version for session invalidation on password change
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
