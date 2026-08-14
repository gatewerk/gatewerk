import { pgTable, text, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { reviews } from "./reviews";
import { projects } from "./projects";

export const reviewTokens = pgTable("review_tokens", {
  id: text("id").primaryKey(),
  token_hash: text("token_hash").notNull(),
  review_id: text("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  used_at: timestamp("used_at", { withTimezone: true }),
  opened_at: timestamp("opened_at", { withTimezone: true }),
  decision: text("decision"),
  ip_address: text("ip_address"),
  user_agent: text("user_agent"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  purpose: text("purpose").notNull().default(""),
  recipient_label: text("recipient_label").notNull(),
  note: text("note"),
  auth_level: text("auth_level").notNull().default("public"),
  auth_email: text("auth_email"),
  auth_user_id: text("auth_user_id"),
  created_by_kind: text("created_by_kind").notNull(),
  created_by_id: text("created_by_id").notNull(),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  revoked_by: text("revoked_by"),
  decided_by_email: text("decided_by_email"),
  decided_by_user_id: text("decided_by_user_id"),
  is_preview: boolean("is_preview").notNull().default(false),
  verification_attempts: integer("verification_attempts").notNull().default(0),
  otp_locked_until: timestamp("otp_locked_until", { withTimezone: true }),
}, (t) => [
  uniqueIndex("review_tokens_token_hash_idx").on(t.token_hash),
  index("review_tokens_review_id_idx").on(t.review_id),
  index("review_tokens_review_id_created_at_idx").on(t.review_id, t.created_at.desc()),
  index("review_tokens_project_id_expires_at_idx").on(t.project_id, t.expires_at),
]);
