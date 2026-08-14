import type { AppDb } from "@gatewerk/db";
import type { createReviewService } from "../../services/reviews";
import type { createReviewTokenService } from "../../services/review-tokens";
import type { WebhookService } from "../../services/webhooks";
import type { EventBus } from "../../services/events";
import type { createAuditService } from "../../services/audit";
import type { ChainEngine } from "../../services/chain-engine";
import type { EmailService } from "../../services/email";

// Dependency bundle threaded through every sub-router factory. The parent index.ts
// constructs this once and passes it to each per-concern factory so the routes stay
// thin and share a single service / webhook / audit surface.
export type ReviewRouteDeps = {
  db: AppDb;
  service: ReturnType<typeof createReviewService>;
  tokenService: ReturnType<typeof createReviewTokenService>;
  webhooks: WebhookService;
  eventBus?: EventBus;
  auditService?: ReturnType<typeof createAuditService>;
  // M12: required for POST /reviews to spawn a chain when the target template
  // carries chain_config. Optional because some spawn sites (token-review,
  // partial test bundles) don't exercise chain spawning.
  chainEngine?: ChainEngine;
  /** SMTP guard for email_otp token generation (Task 5). Absence === unconfigured. */
  emailService?: EmailService;
};
