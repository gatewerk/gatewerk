import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core'
import type { NotificationPrefs } from '@gatewerk/shared'
import { reviewers } from './reviewers'

export const notificationPreferences = pgTable('notification_preferences', {
  // Migration 086: ON DELETE CASCADE so a genuine reviewers-row deletion
  // (e.g. the Cloud data-cleanup job) never orphans this table. DELETE
  // /account anonymizes the reviewers row in place rather than deleting it,
  // so that path deletes this row explicitly instead of relying on the
  // cascade (see routes/account.ts).
  reviewer_id: text('reviewer_id').primaryKey().references(() => reviewers.id, { onDelete: 'cascade' }),
  prefs: jsonb('prefs').$type<NotificationPrefs>().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
