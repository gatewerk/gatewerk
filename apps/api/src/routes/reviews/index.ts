import { Router } from "express";
import { createReviewService } from "../../services/reviews";
import { createReviewTokenService } from "../../services/review-tokens";
import { WebhookService } from "../../services/webhooks";
import type { AppDb } from "@gatewerk/db";
import type { EventBus } from "../../services/events";
import type { createAuditService } from "../../services/audit";
import type { ChainEngine } from "../../services/chain-engine";
import type { EmailService } from "../../services/email";
import { createReviewActionRoutes } from "./action";
import { createReviewBulkRoutes } from "./bulk";
import { createReviewCrudRoutes } from "./crud";
import { createReviewDecideRoutes } from "./decide";
import { createExpiredTokenRoutes } from "./expired";
import { createReviewLifecycleRoutes } from "./lifecycle";
import { createReviewTokenRoutes } from "./tokens";
import { createReviewNotesRoutes } from "./notes";
import { createReviewHoldRoutes } from "./hold";
import { createReviewMonitoringRoutes } from "./monitoring";

// Composes the review-routes surface from six per-concern factories.
// Mount order matters for Express path matching: bulk MUST come before crud
// because /bulk/archive would otherwise be captured by /:id in crud. Crud /:id
// also shadows the more-specific suffixed routes (decide/retry/archive/etc.),
// but Express scans nested routers in registration order — the suffixed matchers
// on later routers still win for their specific paths since Express only calls
// crud's /:id handler when no more specific match was found in a prior router.
export function createReviewRoutes(
  db: AppDb,
  eventBus?: EventBus,
  auditService?: ReturnType<typeof createAuditService>,
  webhooks?: WebhookService,
  chainEngine?: ChainEngine,
  emailService?: EmailService,
): Router {
  const router = Router();
  const service = createReviewService(db);
  const tokenService = createReviewTokenService(db);
  // Terminal veto-failure events (review.veto_delivery_failed) are only emitted
  // when the prod wiring in app.ts injects the eventBus into WebhookService.
  // This fallback is eventBus-less; that is intentional (route-level WebhookService
  // is a test/fallback path; prod always goes through the app.ts-constructed instance).
  const wh = webhooks || new WebhookService({ db });

  const deps = { db, service, tokenService, webhooks: wh, eventBus, auditService, chainEngine, emailService };

  router.use(createReviewBulkRoutes(deps));
  router.use(createReviewHoldRoutes(deps));
  // Monitoring terminal endpoints (veto/confirm) mounted BEFORE action/decide/crud
  // so /:id suffixed routes are not shadowed by the plain /:id crud handler.
  router.use(createReviewMonitoringRoutes(deps));
  router.use(createReviewActionRoutes(deps));
  router.use(createReviewDecideRoutes(deps));
  router.use(createReviewLifecycleRoutes(deps));
  router.use(createReviewTokenRoutes(deps));
  router.use(createReviewNotesRoutes(deps));
  // Mounted before crud so GET /:id doesn't shadow /expired-token-summary.
  router.use(createExpiredTokenRoutes(deps));
  router.use(createReviewCrudRoutes(deps));

  return router;
}
