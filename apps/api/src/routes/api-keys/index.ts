import { Router } from "express";
import type { AppDb } from "@gatewerk/db";
import type { EventBus } from "../../services/events";
import type { createAuditService } from "../../services/audit";
import { createReviewService } from "../../services/reviews";
import { sessionAuth } from "../../middleware/session-auth";
import { requireRole } from "../../middleware/require-role";
import { createApiKeyCrudRoutes } from "./crud";
import { createApiKeyLifecycleRoutes } from "./lifecycle";

// Composes the api-keys surface from two per-concern factories.
// All handlers require session auth + admin role (applied at router level
// BEFORE the sub-routers mount, so every downstream handler inherits).
//
// Mount order note: crud and lifecycle share no path collision — crud owns
// `/` (list, create), `/:id` (update, delete); lifecycle owns suffixed paths
// `/:id/rotate`, `/:id/test`, `/:id/usage`. Express dispatches by method+path;
// bare `/:id` never shadows `/:id/rotate` because path lengths differ.
export function createApiKeyRoutes(
  db: AppDb,
  eventBus?: EventBus,
  auditService?: ReturnType<typeof createAuditService>,
): Router {
  const router = Router();
  const reviewService = createReviewService(db);

  // All API key routes require JWT session auth + admin role
  router.use(sessionAuth(db));
  router.use(requireRole("admin"));

  const deps = { db, reviewService, eventBus, auditService };

  router.use(createApiKeyCrudRoutes(deps));
  router.use(createApiKeyLifecycleRoutes(deps));

  return router;
}
