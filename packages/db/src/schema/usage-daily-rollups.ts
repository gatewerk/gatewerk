import { pgTable, text, integer, date, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const usageDailyRollups = pgTable("usage_daily_rollups", {
  id: text("id").primaryKey(),
  organization_id: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  event_type: text("event_type").notNull(),
  rollup_date: date("rollup_date").notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [
  unique("usage_daily_rollups_org_type_date_uniq").on(t.organization_id, t.event_type, t.rollup_date),
  index("usage_daily_rollups_org_date_idx").on(t.organization_id, t.rollup_date),
]);
