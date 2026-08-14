-- 027-notes-layer.sql
-- Notes-layer Phase A. Supersedes review_notes; backfills with gw_nt_ IDs preserved.

-- 0. Prereq: pgcrypto for gen_random_bytes() used in the attachment backfill
--    at section 4 below. Idempotent — Supabase enables it by default but we
--    don't depend on that.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. notes table
CREATE TABLE IF NOT EXISTS notes (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id                TEXT REFERENCES reviewers(id) ON DELETE SET NULL,
  author_display_fallback  TEXT,
  body                     TEXT NOT NULL,
  tags                     TEXT[] NOT NULL DEFAULT '{}',
  is_shared                BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ,
  CONSTRAINT notes_author_present CHECK (
    author_id IS NOT NULL OR author_display_fallback IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS notes_project_shared_idx
  ON notes(project_id, is_shared, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notes_author_idx
  ON notes(project_id, author_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notes_tags_idx
  ON notes USING GIN (tags)
  WHERE deleted_at IS NULL;

-- 2. note_attachments table
CREATE TABLE IF NOT EXISTS note_attachments (
  id            TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('review', 'template', 'chain_run')),
  target_id     TEXT NOT NULL,
  attached_by   TEXT REFERENCES reviewers(id) ON DELETE SET NULL,
  attached_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (note_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS note_attachments_target_idx
  ON note_attachments(target_kind, target_id);

CREATE INDEX IF NOT EXISTS note_attachments_note_idx
  ON note_attachments(note_id);

-- 3. Backfill from review_notes (preserve gw_nt_ IDs verbatim).
-- INNER JOIN through reviews ensures we never insert a note without a project_id.
-- review_notes.review_id has ON DELETE CASCADE, so orphan rows shouldn't exist —
-- but the JOIN is still defensive.
INSERT INTO notes (
  id, project_id, author_id, author_display_fallback, body, is_shared, created_at, updated_at
)
SELECT
  rn.id,                           -- preserve gw_nt_ IDs verbatim
  r.project_id,                    -- inherit project from referenced review
  NULL,                            -- legacy author was display string, no FK target
  rn.author,                       -- display string falls back here
  rn.content,                      -- body
  TRUE,                            -- legacy notes were team-visible -> shared
  rn.created_at,
  rn.created_at                    -- updated_at == created_at on backfill
FROM review_notes rn
JOIN reviews r ON r.id = rn.review_id
ON CONFLICT (id) DO NOTHING;       -- idempotent: re-running migration is safe

-- 4. Backfill attachments: every legacy note becomes pinned to its original review.
INSERT INTO note_attachments (
  id, note_id, target_kind, target_id, attached_by, attached_at
)
SELECT
  'gw_pin_' || translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_'),
  rn.id,
  'review',
  rn.review_id,
  NULL,                            -- pinner unknown for legacy rows
  rn.created_at
FROM review_notes rn
WHERE NOT EXISTS (
  SELECT 1 FROM note_attachments na
  WHERE na.note_id = rn.id AND na.target_kind = 'review' AND na.target_id = rn.review_id
);                                 -- idempotent guard

-- 5. review_notes table NOT dropped here.
--    Read-only post-migration; new writes go to notes via shim.
--    Drop deferred to v1.4 cleanup migration after shim sunset.
--    CI lint (no-review-notes-imports) blocks new code references (Task 22).
