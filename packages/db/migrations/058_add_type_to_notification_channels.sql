-- Migration 058: Add `type` to notification_channels for payload-format adapters.
-- Existing rows default to 'generic' (current JSON behavior). Slack/Discord/Telegram
-- channels use type-specific transformers to match each platform's payload contract.
-- Idempotent: re-runs are no-ops via IF NOT EXISTS + pg_constraint lookup.

ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'generic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_channels_type_check'
  ) THEN
    ALTER TABLE notification_channels
      ADD CONSTRAINT notification_channels_type_check
      CHECK (type IN ('generic', 'slack', 'discord', 'telegram'));
  END IF;
END $$;
