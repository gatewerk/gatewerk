import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  organization_id: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  event_type: text("event_type").notNull(),
  counted_at: timestamp("counted_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata"),
}, (t) => [
  index("usage_events_org_type_date_idx")
    .on(t.organization_id, t.event_type, t.counted_at),
]);
