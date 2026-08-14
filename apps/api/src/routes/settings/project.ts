import { Router } from "express";
import { eq } from "drizzle-orm";
import { projects, apiKeys } from "@gatewerk/db/src/schema/index";
import {
  envelope,
  InvalidRequestError,
  NotFoundError,
  ProjectUpdateBodySchema,
} from "@gatewerk/shared";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import { validateWebhookUrlWithDns } from "../../lib/ssrf";
import type { SettingsRouteDeps } from "./_deps";

/**
 * A project webhook URL reduced to its origin, for an audit `details` blob.
 *
 * The full URL must not enter the ledger. Operators paste whatever endpoint they
 * have here, and for Slack or Discord that URL carries its bearer credential IN
 * THE PATH. GET/PUT already echo the full value back to admins, but audit_log is
 * different in kind: it is append-only and permanent, so a secret written here
 * outlives the row, the rotation and the project. The origin is what an
 * exfiltration investigation needs — which host review data was pointed at.
 *
 * Duplicated deliberately from the twin in ./webhooks.ts rather than extracted:
 * a shared lib/ helper is the right home for it and is worth doing once a third
 * caller appears.
 */
function auditableWebhookOrigin(url: unknown): string {
  if (typeof url !== "string" || url === "") return "<none>";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable>";
  }
}

export function createSettingsProjectRoutes(deps: SettingsRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // GET /api/v1/settings/project — any authenticated user. The project's
  // name/description is benign info needed by the Settings shell for all
  // roles. Sensitive operational fields (webhook_url, api_keys) are
  // redacted for non-admin callers.
  router.get("/project", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const callerRole = (req as any).reviewer?.role;
      const isAdmin = callerRole === "admin" || callerRole === "owner";

      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project) {
        throw new NotFoundError("Project not found", "project_not_found");
      }

      const keys = isAdmin
        ? await db
            .select({ key_prefix: apiKeys.key_prefix, id: apiKeys.id, is_active: apiKeys.is_active })
            .from(apiKeys)
            .where(eq(apiKeys.project_id, projectId))
        : [];

      res.json(envelope("project", {
        id: project.id,
        name: project.name,
        description: project.description,
        webhook_url: isAdmin ? project.webhook_url : null,
        api_keys: keys.map((k: any) => ({
          id: k.id,
          key_prefix: k.key_prefix,
          is_active: k.is_active,
        })),
        created_at: project.created_at,
        updated_at: project.updated_at,
      }));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/settings/project — admin only. Mutates project-wide config
  // including webhook_url; non-admin rewrite is a review-event exfiltration path.
  router.put("/project", requireRole("admin"), validate({ body: ProjectUpdateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const { name, description, webhook_url } = req.body;
      const updates: Record<string, any> = { updated_at: new Date() };
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (webhook_url !== undefined) {
        // SSRF guard. Nothing reads projects.webhook_url anywhere in the
        // repo — outgoing webhooks come from notification_channels
        // (services/notifications.ts) and agent callbacks from the
        // per-review callback_url. The guard stays regardless: the column
        // is still operator-settable and echoed back, so an unvalidated
        // value would be a stored SSRF target the moment anyone does wire
        // a dispatcher.
        if (webhook_url !== null && webhook_url !== "") {
          try {
            await validateWebhookUrlWithDns(webhook_url);
          } catch (err: any) {
            throw new InvalidRequestError(
              `Invalid webhook URL: ${err.message}`,
              "webhook_url",
              "invalid_webhook_url",
            );
          }
        }
        updates.webhook_url = webhook_url;
      }

      // Prior webhook_url, read only so the audit row can say what it was
      // BEFORE this write. The projects row holds a single current value, and
      // `.returning()` gives the post-update state, so without this read a
      // repoint is recorded as a destination with no origin — which is the half
      // of the question an exfiltration investigation actually needs.
      const priorWebhookUrl = auditService && webhook_url !== undefined
        ? (await db
            .select({ webhook_url: projects.webhook_url })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1))[0]?.webhook_url ?? null
        : null;

      const [updated] = await db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, projectId))
        .returning();

      // Tier 2 REQUIRED (services/AUDIT-WRITE-CONTRACT.md). This route is
      // admin-only precisely because redirecting webhook_url is a review-event
      // exfiltration path, so who moved it and where it pointed are the audit's
      // whole purpose. Actor matches the `reviewer:<email>` convention the rest
      // of routes/settings/** uses.
      if (auditService) {
        await auditService.log({
          action: "project.updated",
          actor: `reviewer:${(req as any).reviewer?.email ?? "unknown"}`,
          resource_type: "project",
          resource_id: projectId,
          details: {
            changed_keys: Object.keys(updates).filter((k) => k !== "updated_at"),
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined
              ? { description_set: description !== null && description !== "" }
              : {}),
            ...(webhook_url !== undefined
              ? {
                  webhook_url_origin_from: auditableWebhookOrigin(priorWebhookUrl),
                  webhook_url_origin_to: auditableWebhookOrigin(updated.webhook_url),
                }
              : {}),
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      res.json(envelope("project", {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        webhook_url: updated.webhook_url,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
