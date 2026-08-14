import { Router } from "express";
import type { AppDb } from "@gatewerk/db";
import type { EmailService } from "../../services/email/index";
import type { AuditService } from "../../services/audit";
import { runDailyDigest } from "../../services/jobs/daily-digest-handler";
import { BadGatewayError } from "../../lib/http-errors";

// Admin-session-only manual trigger for the daily-digest job. Idempotent
// (same-day re-call returns {status:"skipped"} without re-sending emails).
// Useful for live-verify after deploy and for an operator who notices a
// gap and wants to flush today's batch immediately.
export function createAdminJobRoutes(
  db: AppDb,
  email: EmailService,
  audit: AuditService,
): Router {
  const router = Router();

  router.post("/daily-digest/run", async (_req, res, next) => {
    try {
      const result = await runDailyDigest(db, email, audit, new Date());
      if (result.status === "completed" && result.dispatched === 0 && result.failed > 0) {
        return res.status(502).json({
          ...new BadGatewayError("All digest sends failed", "all_sends_failed").toJSON(),
          result,
        });
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
