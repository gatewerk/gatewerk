import { Router } from "express";
import { eq, and, inArray, desc, gte, sql } from "drizzle-orm";
import { apiKeys, apiKeyUsage, templates } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
} from "@gatewerk/shared";
import type { Priority } from "@gatewerk/shared";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { generateApiKey } from "../../lib/generate-api-key";
import type { ApiKeyRouteDeps } from "./_deps";

/**
 * Synthesize a plausible test payload for a template's fields.
 * Media fields (image/video) are skipped — we never want the test endpoint
 * to download or decode media.
 */
function synthesizeTestPayload(fields: Array<{ name: string; type: string; options?: string[] }>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.type) {
      case "text":
        payload[f.name] = `test ${f.name}`;
        break;
      case "markdown":
        payload[f.name] = `## Test review\n\nThis is a synthetic payload for **${f.name}**.`;
        break;
      case "json":
        payload[f.name] = { source: "test", field: f.name };
        break;
      case "number":
        payload[f.name] = 42;
        break;
      case "boolean":
        payload[f.name] = true;
        break;
      case "select":
      case "buttons":
        payload[f.name] = f.options?.[0] ?? "option_a";
        break;
      case "date":
        payload[f.name] = new Date().toISOString().slice(0, 10);
        break;
      case "url":
        payload[f.name] = "https://example.com";
        break;
      case "image":
      case "video":
        // Skip — we don't want the test endpoint to download media.
        break;
      default:
        payload[f.name] = `test ${f.name}`;
    }
  }
  return payload;
}

export function createApiKeyLifecycleRoutes(deps: ApiKeyRouteDeps): Router {
  const router = Router();
  const { db, reviewService, eventBus, auditService } = deps;

  // ─── Rotate Key ───
  // POST /api/v1/settings/api-keys/:id/rotate
  //
  // Audit contract: every successful rotate emits an `api_key.rotated`
  // audit entry carrying `{prev_prefix, new_prefix, ip, user_agent}` so
  // operators can reconstruct rotation timelines and distinguish legitimate
  // rotations from an attacker-initiated key swap on a compromised admin
  // session. Grace window (two-key acceptance) deferred to v1.3 — the
  // audit-log-only fix closes the auditability gap and the immediate
  // invalidation is an operator ergonomics issue, not a security one.
  router.post("/:id/rotate", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      // Capture the current key prefix before the UPDATE so the audit entry
      // can record prev -> new. A missing row here is indistinguishable from
      // the post-update miss below; both resolve to NotFoundError.
      const [existing] = await db
        .select({ key_prefix: apiKeys.key_prefix })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, req.params.id),
            eq(apiKeys.project_id, projectId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      // Generate new key
      const { raw, hash, prefix } = generateApiKey();

      const [updated] = await db
        .update(apiKeys)
        .set({
          key_hash: hash,
          key_prefix: prefix,
        })
        .where(
          and(
            eq(apiKeys.id, req.params.id),
            eq(apiKeys.project_id, projectId),
          ),
        )
        .returning();

      if (!updated) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      if (auditService) {
        const reviewer = (req as any).reviewer;
        const actor = reviewer?.email
          ? `reviewer:${reviewer.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({
          action: "api_key.rotated",
          actor,
          resource_type: "api_key",
          resource_id: updated.id,
          details: {
            prev_prefix: existing.key_prefix,
            new_prefix: updated.key_prefix,
            ip: req.ip,
            user_agent: req.get("user-agent") ?? null,
          },
          project_id: projectId,
        }).catch(() => {});
      }

      // Strip key_hash from response
      const { key_hash, ...safe } = updated;

      res.json({
        ...envelope("api_key", safe),
        raw_key: raw,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── Send Test Request ───
  // POST /api/v1/settings/api-keys/:id/test
  // Creates a synthetic review in the project's Inbox marked with
  // metadata.source = "test". Lets developers verify end-to-end integration
  // (auth + template selection + review creation) without writing code.
  //
  // Side effects: emits `review.created` on the event bus so the Inbox SSE
  // stream picks it up live. Does NOT fire notification webhooks — tests
  // shouldn't spam real Slack channels.
  router.post("/:id/test", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      // Load the key to honor its template_ids restriction (if any)
      const [key] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.project_id, projectId)))
        .limit(1);

      if (!key) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      if (key.is_active === false) {
        throw new ConflictError("API key is disabled", "api_key_inactive");
      }

      // Pick an eligible template:
      //   1. Active (not draft / inactive)
      //   2. If the key restricts template_ids, must be in that list
      const allowedIds = Array.isArray(key.template_ids) ? (key.template_ids as string[]) : null;

      const conditions = [
        eq(templates.project_id, projectId),
        eq(templates.status, "active"),
      ];
      if (allowedIds && allowedIds.length > 0) {
        conditions.push(inArray(templates.id, allowedIds));
      }

      const [tpl] = await db
        .select()
        .from(templates)
        .where(and(...conditions))
        .limit(1);

      if (!tpl) {
        throw new InvalidRequestError(
          allowedIds && allowedIds.length > 0
            ? "No active templates in this key's allowed template list. Activate a template or broaden the key's template access."
            : "No active templates found in this project. Create and activate a template before sending a test request.",
          "template",
          "no_active_template",
        );
      }

      const tplFields = tpl.fields as Array<{ name: string; type: string; options?: string[] }>;
      const payload = synthesizeTestPayload(tplFields);

      const reviewer = (req as any).reviewer;
      const triggeredBy = reviewer?.email || "unknown";

      const review = await reviewService.create(projectId, {
        template: tpl.slug,
        payload,
        priority: "normal",
        metadata: {
          source: "test",
          triggered_by_api_key_id: key.id,
          triggered_by_api_key_prefix: key.key_prefix,
          triggered_by_user: triggeredBy,
        },
      });

      // Emit to event bus so the Inbox SSE stream picks it up live
      if (eventBus && !(review as any).auto_approved) {
        eventBus.emit("review.created", {
          review_id: review.id,
          template: review.template_slug,
          project_id: review.project_id,
          priority: review.priority as Priority,
          created_at: review.created_at.toISOString(),
        });
      }

      // Audit: distinct action so it's filterable and obviously not a real request
      if (auditService) {
        auditService.log({
          action: "api_key.test_request",
          actor: `user:${triggeredBy}`,
          resource_type: "api_key",
          resource_id: key.id,
          details: {
            review_id: review.id,
            template_slug: tpl.slug,
            auto_approved: (review as any).auto_approved === true,
          },
          project_id: projectId,
        }).catch(() => {});
      }

      // Test-request review response normalized to always include `template` (null here —
      // no leftJoin on this path). Keeps wire shape aligned with ReviewObjectSchema.
      res.status(201).json({
        ...envelope("review", { ...review, template: (review as any).template ?? null, iteration_count: review.current_version - 1 }),
        test: true,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── Usage metrics (Phase 4) ───
  // GET /api/v1/settings/api-keys/:id/usage?recent_limit=10
  //
  // Returns a single aggregated payload for the per-key observability panel:
  //   requests_today      — COUNT(*) since UTC midnight
  //   rate_limit_used_pct — COUNT(*) in the last 1h / rate_limit_per_hour × 100
  //                         (null if the key has no rate_limit_per_hour set)
  //   rate_limit_per_hour — echoed from the key row so the UI can format labels
  //   sparkline           — last 24h, 1h buckets, populated buckets only
  //                         [{ hour: ISO timestamp, count: N }]
  //   recent_requests     — last N (default 10, max 100) with endpoint/method/status/ts
  //
  // All queries ride the single (api_key_id, created_at DESC) covering index on
  // `api_key_usage`. p95 < 100ms at 10k req/day/project per spec target.
  router.get("/:id/usage", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const [key] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.project_id, projectId)))
        .limit(1);

      if (!key) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      const recentLimitRaw = Number(req.query.recent_limit ?? 10);
      const recentLimit = Number.isFinite(recentLimitRaw)
        ? Math.max(1, Math.min(100, Math.trunc(recentLimitRaw)))
        : 10;

      const now = new Date();
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Run aggregations in parallel — independent reads on the same index.
      const [todayRow, lastHourRow, sparklineRows, recentRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(apiKeyUsage)
          .where(and(eq(apiKeyUsage.api_key_id, key.id), gte(apiKeyUsage.created_at, startOfDay))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(apiKeyUsage)
          .where(and(eq(apiKeyUsage.api_key_id, key.id), gte(apiKeyUsage.created_at, oneHourAgo))),
        db
          .select({
            hour: sql<string>`date_trunc('hour', ${apiKeyUsage.created_at})`,
            count: sql<number>`count(*)::int`,
          })
          .from(apiKeyUsage)
          .where(and(eq(apiKeyUsage.api_key_id, key.id), gte(apiKeyUsage.created_at, twentyFourHoursAgo)))
          .groupBy(sql`date_trunc('hour', ${apiKeyUsage.created_at})`)
          .orderBy(sql`date_trunc('hour', ${apiKeyUsage.created_at}) ASC`),
        db
          .select({
            endpoint: apiKeyUsage.endpoint,
            method: apiKeyUsage.method,
            status_code: apiKeyUsage.status_code,
            created_at: apiKeyUsage.created_at,
          })
          .from(apiKeyUsage)
          .where(eq(apiKeyUsage.api_key_id, key.id))
          .orderBy(desc(apiKeyUsage.created_at))
          .limit(recentLimit),
      ]);

      const requestsToday = todayRow[0]?.count ?? 0;
      const lastHourCount = lastHourRow[0]?.count ?? 0;
      const rateLimitPerHour = (key.rate_limit_per_hour as number | null) ?? null;
      const rateLimitUsedPct =
        rateLimitPerHour && rateLimitPerHour > 0
          ? Math.round((lastHourCount / rateLimitPerHour) * 100)
          : null;

      // Normalize sparkline hour values to ISO strings — pg returns Date or string
      // depending on the driver (pg-node vs pglite). `new Date(x)` accepts either.
      const sparkline = sparklineRows.map((r) => ({
        hour: new Date(r.hour as unknown as string | Date).toISOString(),
        count: r.count,
      }));

      const recentRequests = recentRows.map((r) => ({
        endpoint: r.endpoint,
        method: r.method,
        status_code: r.status_code,
        created_at: new Date(r.created_at as unknown as string | Date).toISOString(),
      }));

      res.json({
        requests_today: requestsToday,
        rate_limit_used_pct: rateLimitUsedPct,
        rate_limit_per_hour: rateLimitPerHour,
        sparkline,
        recent_requests: recentRequests,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
