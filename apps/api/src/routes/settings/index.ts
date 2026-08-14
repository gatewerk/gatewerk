import { Router } from "express";
import type { AppDb } from "@gatewerk/db";
import { sessionAuth } from "../../middleware/session-auth";
import type { createAuditService } from "../../services/audit";
import type { EmailService } from "../../services/email";
import { createSettingsProjectRoutes } from "./project";
import { createSettingsHmacRoutes } from "./hmac";
import { createSettingsWebhookRoutes } from "./webhooks";
import { createSettingsTeamRoutes } from "./team";
import { createSettingsEmailRoutes } from "./email";

// Composes the settings surface from five per-concern factories.
// All handlers require session auth (applied at router level BEFORE the
// sub-routers mount). Admin role is enforced per-route inside sub-routers
// since settings mixes admin-only (hmac, team.invite/update/delete, email)
// and any-authenticated (project.get, webhooks, team.get) routes.
//
// Mount order: all sub-routers have distinct static path prefixes
// (/project, /hmac-secret, /webhooks, /team, /email) so there is no path
// collision; order is a readability choice (domain groupings first).
export function createSettingsRoutes(
  db: AppDb,
  auditService?: ReturnType<typeof createAuditService>,
  emailService?: EmailService,
): Router {
  const router = Router();

  // All settings routes require JWT session auth
  router.use(sessionAuth(db));

  const deps = { db, auditService, emailService };

  router.use(createSettingsProjectRoutes(deps));
  router.use(createSettingsHmacRoutes(deps));
  router.use(createSettingsWebhookRoutes(deps));
  router.use(createSettingsTeamRoutes(deps));
  router.use(createSettingsEmailRoutes(deps));

  return router;
}
