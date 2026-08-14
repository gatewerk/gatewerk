-- Template draft config: unpublished changes to an active or inactive template.
-- Single-entity staging model (like Retool / Typeform):
--   • `fields`, `actions`, etc. are the PUBLISHED config — what agents see.
--   • `draft_config` is the working copy — edits auto-save here without affecting agents.
--   • "Publish" atomically copies draft_config into the published columns, then clears draft_config.
--   • "Discard" clears draft_config, leaving the published config untouched.
-- Drafts are never null→non-null transiently; auto-save debounces on the client.

ALTER TABLE templates ADD COLUMN IF NOT EXISTS draft_config JSONB;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMP WITH TIME ZONE;

-- Partial index so the Drafts filter query stays fast regardless of project size.
CREATE INDEX IF NOT EXISTS templates_draft_idx
  ON templates (project_id, draft_updated_at DESC)
  WHERE draft_config IS NOT NULL;
