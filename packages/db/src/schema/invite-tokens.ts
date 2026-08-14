import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { reviewers } from "./reviewers";

export const inviteTokens = pgTable("invite_tokens", {
  id: text("id").primaryKey(),
  token_hash: text("token_hash").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("reviewer"),
  invited_by: text("invited_by").notNull().references(() => reviewers.id),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  used_at: timestamp("used_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("invite_tokens_token_hash_idx").on(t.token_hash),
  index("invite_tokens_email_idx").on(t.email),
]);
