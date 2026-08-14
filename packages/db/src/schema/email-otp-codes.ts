import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { reviewTokens } from "./review-tokens";

export const emailOtpCodes = pgTable("email_otp_codes", {
  id: text("id").primaryKey(),
  token_id: text("token_id").notNull().references(() => reviewTokens.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  code_hash: text("code_hash").notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  verified_at: timestamp("verified_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("email_otp_codes_token_id_idx").on(t.token_id),
]);
