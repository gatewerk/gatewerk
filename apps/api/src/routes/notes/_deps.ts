import type { AppDb } from "@gatewerk/db";
import type { createAuditService } from "../../services/audit";

export type NotesRouteDeps = {
  db: AppDb;
  auditService: ReturnType<typeof createAuditService>;
};
