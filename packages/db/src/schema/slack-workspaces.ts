import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { organizations } from './organizations'

export const slackWorkspaces = pgTable(
  'slack_workspaces',
  {
    id: text('id').primaryKey(),
    organization_id: text('organization_id')
      .references(() => organizations.id, { onDelete: 'cascade' }),
    team_id: text('team_id').notNull(),
    team_name: text('team_name'),
    bot_token_encrypted: text('bot_token_encrypted').notNull(),
    bot_user_id: text('bot_user_id'),
    installed_by_reviewer_id: text('installed_by_reviewer_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    teamIdUnique: uniqueIndex('slack_workspaces_team_id_idx').on(t.team_id),
  }),
)
