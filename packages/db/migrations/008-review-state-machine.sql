-- Migration 008: Review State Machine + Auto-Approve + Draft Support
-- Date: 2026-03-28
-- Context: Business logic spec — adds changes_requested status support,
-- auto-approve toggle, template config fields, and draft save columns.

-- 1. Templates: add auto_approve, timeout, instructions
ALTER TABLE templates ADD COLUMN IF NOT EXISTS auto_approve boolean DEFAULT false;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS timeout_seconds integer;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS timeout_action text;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS instructions text;

-- 2. Reviews: add draft columns for auto-save
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS draft_payload jsonb;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS draft_by text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS draft_at timestamptz;

-- 3. Reviews: add action tracking columns
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS action_value text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS action_label text;

-- 4. Make callback_url nullable (agents can poll instead of receiving webhooks)
ALTER TABLE reviews ALTER COLUMN callback_url DROP NOT NULL;
