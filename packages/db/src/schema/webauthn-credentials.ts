import { pgTable, text, bigint, timestamp, customType, index } from "drizzle-orm/pg-core";
import { reviewers } from "./reviewers";

// bytea customType — Drizzle 0.45+ doesn't expose bytea as a top-level helper;
// the customType pattern is the canonical workaround documented in Drizzle's docs.
const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const webauthn_credentials = pgTable("webauthn_credentials", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => reviewers.id, { onDelete: "cascade" }),
  credential_id: text("credential_id").notNull().unique(),
  public_key: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: text("transports").array(),
  aaguid: text("aaguid"),
  friendly_name: text("friendly_name").notNull().default(""),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  last_used_at: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [
  index("idx_webauthn_credentials_user_credential")
    .on(table.user_id, table.credential_id),
]);
