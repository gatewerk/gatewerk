import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { reviews } from './reviews'
import { reviewers } from './reviewers'

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    // Migration 086: ON DELETE CASCADE so a genuine reviewers-row deletion
    // (e.g. the Cloud data-cleanup job) never orphans this table. DELETE
    // /account anonymizes the reviewers row in place rather than deleting
    // it, so that path deletes these rows explicitly instead of relying on
    // the cascade (see routes/account.ts).
    reviewer_id: text('reviewer_id').notNull().references(() => reviewers.id, { onDelete: 'cascade' }),
    review_id: text('review_id').references(() => reviews.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    dedup_key: text('dedup_key').notNull(),
    read_at: timestamp('read_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reviewerIdx: index('notifications_reviewer_id_created_at_idx').on(t.reviewer_id, t.created_at),
    dedupUnique: uniqueIndex('notifications_dedup_key_idx').on(t.dedup_key),
  }),
)
