import { pgTable, text, timestamp, boolean, integer, check, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// bytea customType — same local pattern as webauthn-credentials.ts's
// public_key column (Drizzle 0.45+ doesn't expose bytea as a top-level
// helper). Stored on the row rather than in the review-media/R2 pipeline:
// that system's entitlement gate (require-media-access.ts) is keyed to a
// review's project, which an avatar has no relation to, and an avatar is
// small enough (client-resized before upload, capped server-side) that a
// second storage path isn't worth the entitlement rework.
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const reviewers = pgTable("reviewers", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("reviewer"),
  is_active: boolean("is_active").default(true).notNull(),
  must_change_password: boolean("must_change_password").default(false).notNull(),
  token_version: integer("token_version").notNull().default(0),
  last_login_at: timestamp("last_login_at", { withTimezone: true }),
  failed_login_count: integer("failed_login_count").notNull().default(0),
  locked_until: timestamp("locked_until", { withTimezone: true }),
  totp_secret_encrypted: text("totp_secret_encrypted"),
  totp_enabled_at: timestamp("totp_enabled_at", { withTimezone: true }),
  totp_backup_codes: text("totp_backup_codes"),
  last_used_totp_at: timestamp("last_used_totp_at", { withTimezone: true }),
  email_verified_at: timestamp("email_verified_at", { withTimezone: true }),
  password_reset_token_hash: text("password_reset_token_hash"),
  password_reset_expires_at: timestamp("password_reset_expires_at", { withTimezone: true }),
  login_notifications: boolean("login_notifications").notNull().default(true),
  supabase_user_id: text("supabase_user_id").unique(),
  avatar_data: bytea("avatar_data"),
  avatar_content_type: text("avatar_content_type"),
  avatar_updated_at: timestamp("avatar_updated_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Table-level CHECK on role mirrors migration 028. Two roles in OSS
  // edition; cloud may extend via a future migration.
  check("reviewers_role_chk", sql`${t.role} IN ('admin', 'reviewer')`),
]);
