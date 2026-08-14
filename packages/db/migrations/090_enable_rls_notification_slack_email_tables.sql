-- Migration 090: enable Row Level Security on 7 tables left RLS-disabled
-- since creation (migrations 074-081, the notifications/slack/email batch).
-- Date: 2026-08-10
-- Context: Supabase security advisor (08-07) flagged these as
-- readable/writable via the public anon key through the PostgREST auto-API,
-- since Supabase exposes every `public` schema table over PostgREST by
-- default unless RLS is enabled. This app's API server connects to Postgres
-- directly as the table owner (via DATABASE_URL / postgres.js in
-- packages/db), which always bypasses RLS regardless of policies present —
-- RLS only gates roles PostgREST assumes (anon/authenticated). No policies
-- are added here: enabling RLS with zero policies denies all access by
-- default to non-owner roles, which is the desired end state since none of
-- these tables are meant to be reachable from the anon-key auto-API.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs_notification_digest_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_user_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

-- DOWN
-- ALTER TABLE email_sends DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE slack_user_links DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE slack_workspaces DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE jobs_notification_digest_state DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notification_suppressions DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notification_preferences DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
