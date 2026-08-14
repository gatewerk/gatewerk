-- A reviewer's account photo. Stored on the row as bytes, not in the
-- review-media/R2 pipeline (services/media.ts): that pipeline's entitlement
-- gate (require-media-access.ts) authorizes access by looking up a REVIEW's
-- project, which an avatar has no relation to — reusing it would mean
-- bending a carefully-reasoned security gate to a shape it wasn't built
-- for. An avatar is also small (client-resized before upload, capped
-- server-side), so a bytea column costs nothing meaningful in row size and
-- needs no object-storage configuration on self-host, unlike the media
-- pipeline which requires either a writable disk mount or R2 credentials.
--
-- avatar_content_type is one of image/png, image/jpeg, image/webp — never
-- image/svg+xml (an SVG can carry a script; same exclusion services/media.ts
-- already applies to review attachments, for the same reason).
-- avatar_updated_at drives the serving route's Cache-Control/ETag so a
-- replaced or removed photo doesn't keep serving from a client cache.

ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS avatar_content_type TEXT;
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;

-- DOWN
-- ALTER TABLE reviewers DROP COLUMN IF EXISTS avatar_data;
-- ALTER TABLE reviewers DROP COLUMN IF EXISTS avatar_content_type;
-- ALTER TABLE reviewers DROP COLUMN IF EXISTS avatar_updated_at;
