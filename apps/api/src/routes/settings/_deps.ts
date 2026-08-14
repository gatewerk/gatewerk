import type { AppDb } from "@gatewerk/db";
import type { createAuditService } from "../../services/audit";
import type { EmailService } from "../../services/email";

// Dependency bundle threaded through every sub-router factory. The parent
// index.ts constructs this once and passes it to each per-concern factory so
// the routes stay thin. Sub-routers that do not need a given service can
// ignore the optional fields; they are threaded optionally so legacy
// factories do not require the extra plumbing until they add a new dependency.
export type SettingsRouteDeps = {
  db: AppDb;
  auditService?: ReturnType<typeof createAuditService>;
  emailService?: EmailService;
};
