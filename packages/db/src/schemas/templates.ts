// Zod schemas derived from the `templates` Drizzle table via drizzle-zod.
// Single source of truth for template insert/select shape.
// Import from "@gatewerk/db/schemas" — do not redefine shapes elsewhere.
//
// Omissions on insertTemplateSchema:
//   id, created_at, updated_at — server-generated
//   status — server-controlled (publish/pause/resume endpoints)
//   draft_config, draft_updated_at — set by template editor save
//
// Caller-supplied fields kept in the insert schema:
//   allow_request_changes, allow_notes — valid caller inputs; set by template
//     authors via the dashboard create/update routes
//   chain_config and other template-config fields (timeout_seconds,
//     timeout_action, changes_timeout_hours, default_auth_level,
//     default_expiry_seconds, instructions, enable_review_links, etc.)

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { templates } from "../schema/templates";

export const insertTemplateSchema = createInsertSchema(templates).omit({
  id: true,
  status: true,
  draft_config: true,
  draft_updated_at: true,
  created_at: true,
  updated_at: true,
});

export const selectTemplateSchema = createSelectSchema(templates);

// Zod 4 phantom-property: `typeof schema.type` ≡ `z.infer<typeof schema>`.
// The `.type` form is shorter and equivalent for inferring runtime output.
export type InsertTemplate = typeof insertTemplateSchema.type;
export type SelectTemplate = typeof selectTemplateSchema.type;
