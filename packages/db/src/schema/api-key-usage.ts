import { pgTable, text, integer, timestamp, bigserial, index } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";

export const apiKeyUsage = pgTable("api_key_usage", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  api_key_id: text("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  method: text("method").notNull(),
  status_code: integer("status_code").notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("api_key_usage_lookup").on(t.api_key_id, t.created_at.desc()),
]);
