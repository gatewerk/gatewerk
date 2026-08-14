import { Router } from "express";
import { sql } from "drizzle-orm";
import type { AppDb } from "@gatewerk/db";

/**
 * GET /api/v1/admin/password-hash-stats
 *
 * Returns the distribution of password hash formats across all active reviewers.
 * Useful for monitoring the bcrypt → argon2id migration progress without
 * querying the reviewers table directly (which requires DBA access in prod).
 *
 * Access: admin only (enforced at the app.use() mount site in app.ts, matching
 * the pattern used by createAdminJobRoutes). No PII is returned — only
 * aggregate counts.
 *
 * Response shape:
 *   { total: number, formats: { argon2id?: number, bcrypt?: number, unknown?: number }, argon2id_pct: number }
 */
export function createPasswordHashStatsRoute(db: AppDb): Router {
  const router = Router();

  router.get("/password-hash-stats", async (_req, res, next) => {
    try {
      const result = await db.execute(sql`
        SELECT
          CASE
            WHEN password_hash LIKE '$argon2id$%' THEN 'argon2id'
            WHEN password_hash LIKE '$2a$%' OR password_hash LIKE '$2b$%' THEN 'bcrypt'
            ELSE 'unknown'
          END AS format,
          COUNT(*)::int AS count
        FROM reviewers
        WHERE is_active = true
        GROUP BY format
        ORDER BY format
      `);

      const rows = (result as unknown as { rows: { format: string; count: string }[] }).rows;
      const stats: Record<string, number> = Object.fromEntries(
        rows.map((r) => [r.format, Number(r.count)]),
      );
      const total = Object.values(stats).reduce((a, b) => a + b, 0);

      res.json({
        total,
        formats: stats,
        argon2id_pct: total > 0 ? Math.round(((stats.argon2id ?? 0) / total) * 100) : 0,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
