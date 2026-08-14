import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { PlanId } from "@gatewerk/shared";
import { organizations } from "./organizations";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  webhook_url: text("webhook_url"),
  hmac_secret: text("hmac_secret").notNull(),
  organization_id: text("organization_id").references(() => organizations.id),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  plan_id: text("plan_id").$type<PlanId>().notNull().default("community"),
  entitlements_override: jsonb("entitlements_override"),
  trial_ends_at: timestamp("trial_ends_at", { withTimezone: true }),
  seat_count: integer("seat_count").notNull().default(1),
}, (t) => [
  index("projects_org_idx").on(t.organization_id),
  index("idx_projects_plan_id").on(t.plan_id),
]);
