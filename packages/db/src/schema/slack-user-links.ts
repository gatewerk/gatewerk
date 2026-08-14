import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { reviewers } from './reviewers'

export const slackUserLinks = pgTable('slack_user_links', {
  // Migration 086: ON DELETE CASCADE so a genuine reviewers-row deletion
  // (e.g. the Cloud data-cleanup job) never orphans this table, which also
  // holds the reviewer's Slack user id (a third-party identifier). DELETE
  // /account anonymizes the reviewers row in place rather than deleting it,
  // so that path deletes this row explicitly instead of relying on the
  // cascade (see routes/account.ts).
  reviewer_id: text('reviewer_id').primaryKey().references(() => reviewers.id, { onDelete: 'cascade' }),
  slack_user_id: text('slack_user_id').notNull(),
  slack_team_id: text('slack_team_id').notNull(),
  cached_at: timestamp('cached_at', { withTimezone: true }).defaultNow(),
  /** Set when the most recent lookup for this reviewer found no matching
   *  Slack account (usersLookupByEmail returned null). Cleared back to null
   *  on a later successful lookup — a stale flag would nag a user who has
   *  since joined Slack. */
  lookup_failed_at: timestamp('lookup_failed_at', { withTimezone: true }),
})
