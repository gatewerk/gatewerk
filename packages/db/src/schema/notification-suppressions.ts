import { pgTable, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core'

// PRIVACY NOTE: this table's retention is DELIBERATE and must survive
// account deletion. No deletion path (including
// DELETE /account and the Cloud org-deletion job) touches it, and none
// should.
//
// A suppression row records that an address bounced, complained, or asked
// not to be emailed again. Deleting that row when the associated account is
// deleted would not protect that person's privacy, it would undo their own
// opt-out: the address would become contactable again the instant anything
// re-added it (a re-invite, a new signup with the same email, a shared
// inbox), silently reversing the request the row exists to remember.
// Retaining a suppression list after the account it originated from is gone
// is standard practice for exactly this reason: the alternative is
// re-contacting someone who already said no.
//
// There is deliberately no organization_id or reviewer_id column here.
// Suppression is a property of the ADDRESS, not of an account: an address
// can bounce or complain before it is ever associated with a reviewer (a
// stale invite, an external reviewer's one-off token email), and it must
// keep suppressing mail after the account that first triggered it is
// deleted. Tying this table to an account would scope the protection to
// that account's lifetime, which is backwards.
export const notificationSuppressions = pgTable(
  'notification_suppressions',
  {
    id: text('id').primaryKey(),
    address: text('address').notNull(),
    reason: text('reason').notNull(), // 'bounce' | 'complaint' | 'unsubscribe'
    metadata: jsonb('metadata'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    addressIdx: uniqueIndex('notification_suppressions_address_idx').on(t.address),
  }),
)
