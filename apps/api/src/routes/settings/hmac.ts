import { Router } from "express";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { projects } from "@gatewerk/db/src/schema/index";
import { NotFoundError } from "@gatewerk/shared";
import { requireRole } from "../../middleware/require-role";
import { resolveProjectId } from "../../lib/resolve-project-id";
import type { SettingsRouteDeps } from "./_deps";

// HMAC signing secret — used to verify incoming webhook signatures from
// agents that POST results back to us. Independent of the notification
// webhook configuration (settings/webhooks), which is about outgoing events.
//
// Never return the full secret on a plain GET — that leaves no audit trail
// for who saw it (the hmac-secret-exposure-on-read class).
//   GET    /hmac-secret          → preview only (prefix + has_secret)
//   POST   /hmac-secret/reveal   → full secret, audit-logged per call
//   POST   /hmac-secret/rotate   → full secret, generates a new one (unchanged)
export function createSettingsHmacRoutes(deps: SettingsRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // GET /api/v1/settings/hmac-secret — admin only, returns metadata only.
  // The full secret is NOT returned here; callers must POST /reveal to get it.
  router.get("/hmac-secret", requireRole("admin"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const [proj] = await db
        .select({ hmac_secret: projects.hmac_secret })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!proj) {
        throw new NotFoundError("Project not found", "project_not_found");
      }

      const prefix = proj.hmac_secret.slice(0, 8);
      res.json({ prefix, has_secret: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/settings/hmac-secret/reveal — admin only, returns the full
  // signing secret AND emits an audit log entry. Intended for one-shot UI
  // flows (click Reveal → show in modal → copy → close). Each call creates
  // a `hmac_secret.revealed` audit record so operators can trace disclosures.
  router.post("/hmac-secret/reveal", requireRole("admin"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const [proj] = await db
        .select({ hmac_secret: projects.hmac_secret })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!proj) {
        throw new NotFoundError("Project not found", "project_not_found");
      }

      if (auditService) {
        const reviewer = (req as any).reviewer;
        auditService.log({
          action: "hmac_secret.revealed",
          actor: `reviewer:${reviewer?.email ?? "unknown"}`,
          resource_type: "project",
          resource_id: projectId,
          details: {
            prefix: proj.hmac_secret.slice(0, 8),
            ip: req.ip,
            user_agent: req.get("user-agent") ?? null,
          },
          project_id: projectId,
        }).catch(() => {});
      }

      res.json({ hmac_secret: proj.hmac_secret });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/settings/hmac-secret/rotate — admin only.
  //
  // Rotation semantics: the rotate endpoint performs a single UPDATE on
  // `projects.hmac_secret`.
  // Both new outbound deliveries AND pending retries sign with the CURRENT
  // (post-rotate) secret. The retry worker JOINs webhook_deliveries → reviews
  // → projects at attempt time to fetch the live secret — there is no
  // per-row secret snapshot on webhook_deliveries (column dropped in
  // migration 057).
  //
  // Design rationale:
  //   - Receivers MUST dedupe via delivery_id (X-Webhook-Id header), not via
  //     signature. Signature drift across retries is acceptable and documented.
  //   - Dropping the per-row snapshot reduces DB blast-radius: the deliveries
  //     table is hot and broadly queryable; projects.hmac_secret is narrower.
  //   - On rotate, in-flight retries switch to the new secret immediately.
  //     Receivers who have adopted the new secret verify cleanly. Operators
  //     who rotate mid-flight accept that pre-rotate receivers may reject
  //     the new-signature retry — the same receiver-coordination cost exists
  //     regardless, just surfaced earlier.
  //   - Multi-secret grace window (F4) remains deferred; if needed it can be
  //     layered on top without reverting the schema change.
  //
  // Contract locked in by __tests__/hmac-rotation-semantics.test.ts.
  router.post("/hmac-secret/rotate", requireRole("admin"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const newSecret = crypto.randomBytes(32).toString("hex");

      const [prev] = await db
        .select({ hmac_secret: projects.hmac_secret })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      const [updated] = await db
        .update(projects)
        .set({ hmac_secret: newSecret, updated_at: new Date() })
        .where(eq(projects.id, projectId))
        .returning({ hmac_secret: projects.hmac_secret });

      if (!updated) {
        throw new NotFoundError("Project not found", "project_not_found");
      }

      if (auditService) {
        const reviewer = (req as any).reviewer;
        auditService.log({
          action: "hmac_secret.rotated",
          actor: `reviewer:${reviewer?.email ?? "unknown"}`,
          resource_type: "project",
          resource_id: projectId,
          details: {
            prev_prefix: prev?.hmac_secret.slice(0, 8) ?? null,
            new_prefix: updated.hmac_secret.slice(0, 8),
            ip: req.ip,
            user_agent: req.get("user-agent") ?? null,
          },
          project_id: projectId,
        }).catch(() => {});
      }

      res.json({ hmac_secret: updated.hmac_secret });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
