import { Router } from "express";
import { createAuditService } from "../services/audit";
import { listEnvelope } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { requireScope } from "../middleware/require-scope";
import { resolveProjectId } from "../lib/resolve-project-id";

export function createAuditRoutes(db: AppDb): Router {
  const router = Router();
  const auditService = createAuditService(db);

  // GET /api/v1/audit — query audit log entries
  //
  // Cloud-readiness tenant isolation (B2, migration 026): the project filter
  // mirrors the resolveProjectId pattern from routes/stats.ts. API-key auth
  // sets req.projectId; session auth falls through to the oldest project
  // (OSS single-project default). The service-level filter shows NULL rows
  // (system-level audit entries with no clean project mapping) to all admins,
  // which is the less restrictive default — tightening can land in a
  // hardening pass after a prod orphan audit.
  router.get("/", requireScope("audit:read"), async (req, res, next) => {
    try {
      const {
        resource_type,
        resource_id,
        actor,
        from,
        to,
        limit,
        offset,
      } = req.query as Record<string, string>;
      // Express parses repeated `?action=a&action=b` into a string[]
      // automatically; a single `?action=a` stays a plain string. Both are
      // valid shapes for auditService.query, so this is typed as the union
      // rather than forced through the Record<string,string> cast above.
      const action = req.query.action as string | string[] | undefined;

      const projectId = (req as any).projectId ?? (await resolveProjectId(req, db));

      const result = await auditService.query({
        action,
        resource_type,
        resource_id,
        actor,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
        project_id: projectId ?? undefined,
      });

      res.json(listEnvelope("audit_event", result.items, { has_more: result.has_more, total: result.total }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
