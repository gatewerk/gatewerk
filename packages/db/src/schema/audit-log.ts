import { pgTable, text, jsonb, timestamp, index, smallint } from "drizzle-orm/pg-core";

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  resource_type: text("resource_type").notNull(),
  resource_id: text("resource_id"),
  details: jsonb("details"),
  signature: text("signature"),
  // Chain columns added in migration 056. prev_signature links this row to
  // the previous row in the same project_id partition; null for the first row
  // in a partition. signature_version = 1 (default) means legacy single-row
  // HMAC; 2 means v2 chain input (prefix "v2|"); 3 means v2 plus canonical
  // (key-sorted) serialisation of `details`. v2 signed details with plain
  // JSON.stringify, which is key-insertion-order dependent, so any v2 row
  // with 2+ details keys mis-verifies after a JSONB round-trip. v2 rows are
  // still verified under the v2 scheme so history keeps its meaning; all new
  // rows are written as v3.
  prev_signature: text("prev_signature"),
  signature_version: smallint("signature_version").notNull().default(1),
  // Cloud-readiness tenant isolation (B2, migration 026). Nullable in the
  // schema because a) the migration leaves backfill orphans NULL, b) writers
  // pass it best-effort during the gradual-rollout phase, and c) system-level
  // rows that have no clean project mapping legitimately stay NULL. Route
  // filter shows NULL rows to admins (less restrictive); a future hardening
  // pass can NOT-NULL the column after a prod orphan audit.
  project_id: text("project_id"),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("audit_log_created_at_idx").on(t.created_at),
  index("audit_log_project_id_idx").on(t.project_id),
]);
