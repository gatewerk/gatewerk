import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { organizations } from './organizations'

export const emailSends = pgTable(
  'email_sends',
  {
    id: text('id').primaryKey(),
    message_id: text('message_id').notNull(),
    /** Null for any send whose caller could not attribute a tenant. Such rows
     *  still log so the address fallback works. */
    organization_id: text('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    address: text('address').notNull(),
    is_transactional: boolean('is_transactional').notNull().default(true),
    bounced_at: timestamp('bounced_at', { withTimezone: true }),
    complained_at: timestamp('complained_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** No FK on purpose: a send row must outlive its notification for
     *  deliverability forensics, and a cascade delete would erase bounce
     *  history. */
    notification_id: text('notification_id'),
  },
  (t) => ({
    messageIdUnique: uniqueIndex('email_sends_message_id_idx').on(t.message_id),
    orgIdx: index('email_sends_org_created_at_idx').on(t.organization_id, t.created_at.desc()),
    addressIdx: index('email_sends_address_created_at_idx').on(t.address, t.created_at.desc()),
    notificationIdx: index('email_sends_notification_id_idx').on(t.notification_id),
  }),
)
