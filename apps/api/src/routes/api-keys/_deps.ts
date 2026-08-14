import type { AppDb } from "@gatewerk/db";
import type { createReviewService } from "../../services/reviews";
import type { EventBus } from "../../services/events";
import type { createAuditService } from "../../services/audit";

// Dependency bundle threaded through every sub-router factory. The parent
// index.ts constructs this once and passes it to each per-concern factory so
// the routes stay thin and share a single review-service / event-bus / audit
// surface.
export type ApiKeyRouteDeps = {
  db: AppDb;
  reviewService: ReturnType<typeof createReviewService>;
  eventBus?: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
};
