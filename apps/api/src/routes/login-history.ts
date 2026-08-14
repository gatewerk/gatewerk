import { Router } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import { auditLog } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import { sessionAuth } from "../middleware/session-auth";
import { parsePagination } from "../lib/pagination";

const AUTH_ACTIONS = [
  "auth.login_success",
  "auth.login_failure",
  "auth.lockout",
  "auth.logout",
  "auth.2fa_validated",
  "session.revoked",
  "session.revoke_all",
];

export function createLoginHistoryRoutes(db: AppDb): Router {
  const router = Router();

  router.get("/", sessionAuth(db), async (req, res, next) => {
    try {
      const reviewer = (req as any).reviewer;
      const { limit, offset } = parsePagination(req.query);

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actor, reviewer.id),
            inArray(auditLog.action, AUTH_ACTIONS),
          ),
        )
        .orderBy(desc(auditLog.created_at))
        .limit(limit + 1)
        .offset(offset);

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(row => ({
        action: row.action,
        ip_address: (row.details as any)?.ip ?? null,
        user_agent: (row.details as any)?.user_agent ?? null,
        timestamp: row.created_at,
        details: row.details,
      }));

      res.json({ items, has_more: hasMore });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
