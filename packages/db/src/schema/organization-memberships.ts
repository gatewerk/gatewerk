import { pgTable, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { reviewers } from "./reviewers";

export const organizationMemberships = pgTable("organization_memberships", {
  id: text("id").primaryKey(),
  organization_id: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  user_id: text("user_id").notNull().references(() => reviewers.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // owner, admin, member, viewer
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("org_membership_unique").on(t.organization_id, t.user_id),
  index("org_memberships_org_idx").on(t.organization_id),
  index("org_memberships_user_idx").on(t.user_id),
]);
