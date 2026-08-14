-- 029-template-action-flags.sql
-- Per-template feature flags: allow_request_changes (gates the inline
-- "Request Changes" composer action) and allow_notes (gates the entire
-- collaboration / activity surface on reviews using this template).
--
-- Both default TRUE so the migration is non-breaking — existing templates
-- preserve their current "all features on" behavior. Templates can opt out
-- after migration via TemplateEditor toggles.
--
-- Idempotent — safe to re-run.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS allow_request_changes BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS allow_notes BOOLEAN NOT NULL DEFAULT TRUE;
