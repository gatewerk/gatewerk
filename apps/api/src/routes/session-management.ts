import { Router } from "express";
import type { AppDb } from "@gatewerk/db";
import type { AuditAction } from "@gatewerk/shared";
import { InvalidRequestError, NotFoundError } from "@gatewerk/shared";
import { sessionAuth } from "../middleware/session-auth";
import { createSessionService } from "../services/sessions";

interface AuditService {
  log(data: {
    action: AuditAction;
    actor: string;
    resource_type: string;
    resource_id?: string;
    details?: Record<string, unknown>;
  }): Promise<any>;
}

export function createSessionManagementRoutes(db: AppDb, auditService: AuditService): Router {
  const router = Router();
  const sessionService = createSessionService(db);

  // POST /api/v1/auth/logout — revoke current session
  router.post("/logout", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      if (reviewer.sessionId) {
        await sessionService.revoke(reviewer.sessionId, reviewer.id);
        auditService.log({
          action: "auth.logout",
          actor: reviewer.id,
          resource_type: "session",
          resource_id: reviewer.sessionId,
          details: { ip: req.ip },
        }).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/auth/sessions — list active sessions
  router.get("/sessions", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const rows = await sessionService.listForReviewer(reviewer.id);
      const currentJti = reviewer.jti;

      res.json({
        items: rows.map(row => ({
          id: row.id,
          ip_address: row.ip_address,
          user_agent: row.user_agent,
          created_at: row.created_at,
          last_active_at: row.last_active_at,
          is_current: row.jti === currentJti,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/auth/sessions/:id — revoke one session
  router.delete("/sessions/:id", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const targetId = String(req.params.id);

      const revoked = await sessionService.revoke(targetId, reviewer.id);
      if (!revoked) {
        throw new NotFoundError("Session not found");
      }

      auditService.log({
        action: "session.revoked",
        actor: reviewer.id,
        resource_type: "session",
        resource_id: targetId,
        details: { ip: req.ip },
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/sessions/revoke-all — revoke all except current
  router.post("/sessions/revoke-all", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const currentJti = reviewer.jti;

      if (!currentJti) {
        throw new InvalidRequestError("Session does not support revocation", undefined, "legacy_session");
      }

      const count = await sessionService.revokeAllExcept(reviewer.id, currentJti);

      auditService.log({
        action: "session.revoke_all",
        actor: reviewer.id,
        resource_type: "reviewer",
        resource_id: reviewer.id,
        details: { count, ip: req.ip },
      }).catch(() => {});

      res.json({ ok: true, revoked_count: count });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
