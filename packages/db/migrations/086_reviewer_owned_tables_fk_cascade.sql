-- Migration 086: FK + ON DELETE CASCADE from reviewer-owned tables to reviewers(id)
-- Date: 2026-07-27
-- Context: privacy audit (account-deletion data-retention review) found that
-- notifications, notification_preferences, and slack_user_links carry a
-- reviewer_id column but have NO foreign key to reviewers at all. DELETE
-- /account (routes/account.ts) anonymizes the reviewers row in place rather
-- than deleting it, so an FK here would never have fired for that path
-- anyway; the app layer now deletes these three tables' rows explicitly for
-- that reason (see routes/account.ts). But apps/api/ee/jobs/data-cleanup.ts
-- (Cloud trial/cancellation sweep) DOES delete the reviewers row directly,
-- and without this constraint that path silently orphans all three tables.
-- This migration is defense in depth for DELETE /account and a real,
-- previously-missing safety net for the Cloud path.
--
-- Orphan cleanup first: because that Cloud path already deletes reviewers
-- rows today, a real database may already hold rows in these three tables
-- whose reviewer_id no longer resolves to any reviewers.id. Adding a FOREIGN
-- KEY before removing them would fail the migration on such a database, so
-- the orphans are deleted first. Safe no-op where none exist.
DELETE FROM notifications
  WHERE reviewer_id NOT IN (SELECT id FROM reviewers);
DELETE FROM notification_preferences
  WHERE reviewer_id NOT IN (SELECT id FROM reviewers);
DELETE FROM slack_user_links
  WHERE reviewer_id NOT IN (SELECT id FROM reviewers);

-- Drop-then-add keeps each FK idempotent (Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`); matches the idiom in migration 013.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_reviewer_id_reviewers_id_fk;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_reviewer_id_reviewers_id_fk
  FOREIGN KEY (reviewer_id) REFERENCES reviewers(id) ON DELETE CASCADE;

ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_reviewer_id_reviewers_id_fk;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_reviewer_id_reviewers_id_fk
  FOREIGN KEY (reviewer_id) REFERENCES reviewers(id) ON DELETE CASCADE;

ALTER TABLE slack_user_links
  DROP CONSTRAINT IF EXISTS slack_user_links_reviewer_id_reviewers_id_fk;
ALTER TABLE slack_user_links
  ADD CONSTRAINT slack_user_links_reviewer_id_reviewers_id_fk
  FOREIGN KEY (reviewer_id) REFERENCES reviewers(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback; run top-to-bottom to reverse this migration cleanly)
-- -----------------------------------------------------------------------------
-- ALTER TABLE slack_user_links DROP CONSTRAINT IF EXISTS slack_user_links_reviewer_id_reviewers_id_fk;
-- ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_reviewer_id_reviewers_id_fk;
-- ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reviewer_id_reviewers_id_fk;
-- (Orphan deletes above are not reversible; the down migration does not
-- attempt to reconstruct deleted rows.)
