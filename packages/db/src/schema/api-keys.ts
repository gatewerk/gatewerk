import { pgTable, text, timestamp, boolean, jsonb, integer, index } from "drizzle-orm/pg-core";
import { projects } from "./projects";

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  project_id: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  key_hash: text("key_hash").notNull(),
  key_prefix: text("key_prefix").notNull(),
  label: text("label"),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  is_active: boolean("is_active").default(true).notNull(),
  last_used_at: timestamp("last_used_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  name: text("name"),                                                    // Human-friendly name e.g. "Production Agent"
  description: text("description"),                                      // Optional description
  callback_url: text("callback_url"),                                    // URL to POST decisions to
  default_reviewer: text("default_reviewer"),                            // Email of default reviewer
  rate_limit_per_hour: integer("rate_limit_per_hour"),                   // Max requests per hour (null = unlimited)
  template_ids: jsonb("template_ids").$type<string[]>(),                 // string[] of allowed template IDs (null = all)
  expires_at: timestamp("expires_at", { withTimezone: true }),           // Optional expiration; null = never
  ip_allowlist: jsonb("ip_allowlist").$type<string[]>(),                 // string[] of IPs or CIDRs; null = any IP
}, (t) => [
  index("api_keys_key_hash_idx").on(t.key_hash),
]);
