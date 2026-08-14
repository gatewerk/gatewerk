import { Router } from "express";
import { eq, isNotNull } from "drizzle-orm";
import { organizations } from "@gatewerk/db";
import type { AppDb } from "@gatewerk/db";
import { NotFoundError } from "@gatewerk/shared";
import type { AuditService } from "../services/audit";
import { resumeTenant } from "../services/email/pause";

/**
 * Admin resume path for the per-tenant deliverability breaker.
 *
 * The hourly evaluator (jobs/email-pause-evaluator.ts) can only pause a
 * tenant, never resume one: a crossed threshold tells it a rate breached,
 * not whether the underlying cause (a bad list, a broken template, a
 * compromised sender) was fixed. That judgment call is a human's, made here.
 *
 * Access: admin only (enforced at the app.use() mount site in app.ts,
 * matching the pattern used by createAdminJobRoutes / createPasswordHashStatsRoute).
 * This endpoint reveals tenant identities and re enables sending, so it must
 * not be reachable by an ordinary reviewer.
 */
export function createAdminEmailPauseRoutes(db: AppDb, audit: AuditService): Router {
  const router = Router();

  // GET /api/v1/admin/email-pause — lists every currently paused tenant.
  router.get("/", async (_req, res, next) => {
    try {
      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          email_paused_at: organizations.email_paused_at,
          email_pause_reason: organizations.email_pause_reason,
        })
        .from(organizations)
        .where(isNotNull(organizations.email_paused_at));

      res.json({ organizations: rows });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/email-pause/:orgId/resume — clears the pause and
  // lets mail flow again for this tenant.
  router.post("/:orgId/resume", async (req, res, next) => {
    try {
      const { orgId } = req.params;

      const [org] = await db
        .select({ id: organizations.id, email_pause_reason: organizations.email_pause_reason })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!org) {
        throw new NotFoundError("Organization not found", "organization_not_found");
      }

      await resumeTenant(db, orgId);

      // Fire and forget — a transient audit write failure must not turn an
      // already applied resume into a failed request. Surfaces the failure
      // to ops rather than swallowing it, mirroring routes/auth.ts's
      // rehash-audit pattern: a resume that silently failed to audit would
      // be invisible to the operator who just cleared the pause.
      const reviewer = (req as any).reviewer;
      audit
        .log({
          action: "email.tenant_resumed",
          actor: reviewer.id,
          resource_type: "organization",
          resource_id: orgId,
          details: { previous_reason: org.email_pause_reason },
        })
        .catch((err) =>
          console.error("email_pause_resume_audit_failed", { org_id: orgId, err }),
        );

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
