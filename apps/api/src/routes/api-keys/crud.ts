import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { apiKeys, templates } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  envelope,
  listEnvelope,
  InvalidRequestError,
  NotFoundError,
  SCOPES,
  ApiKeyCreateBodySchema,
  ApiKeyUpdateBodySchema,
} from "@gatewerk/shared";
import { validateWebhookUrlWithDns } from "../../lib/ssrf";
import { parseIpOrCidr } from "../../lib/auth-helpers";
import { resolveProjectId } from "../../lib/resolve-project-id";
import { validate } from "../../middleware/validate";
import { generateApiKey } from "../../lib/generate-api-key";
import type { ApiKeyRouteDeps } from "./_deps";

/**
 * Actor for an api_key audit row. Matches the convention the rotate handler in
 * ./lifecycle.ts already established for this resource: a dashboard session is
 * `reviewer:<email>`, an API key acting on another key is `agent:<prefix>`.
 */
function keyActor(req: any): string {
  return req.reviewer?.email
    ? `reviewer:${req.reviewer.email}`
    : `agent:${req.apiKeyPrefix || "unknown"}`;
}

export function createApiKeyCrudRoutes(deps: ApiKeyRouteDeps): Router {
  const router = Router();
  const { db, auditService } = deps;

  // ─── List API Keys ───
  // GET /api/v1/settings/api-keys
  router.get("/", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.project_id, projectId));

      // Strip key_hash from results — only prefix is safe to expose
      const items = rows.map((row: any) => {
        const { key_hash, ...rest } = row;
        return rest;
      });

      res.json(listEnvelope("api_key", items, { has_more: false, total: items.length }));
    } catch (err) {
      next(err);
    }
  });

  // ─── Create API Key ───
  // POST /api/v1/settings/api-keys
  router.post("/", validate({ body: ApiKeyCreateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const {
        name,
        scopes,
        description,
        template_ids,
        callback_url,
        default_reviewer,
        rate_limit_per_hour,
        expires_at,
        ip_allowlist,
      } = req.body;

      // Validate required fields
      if (!name || typeof name !== "string") {
        throw new InvalidRequestError("Missing required field: name", "name", "missing_required_fields");
      }
      if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
        throw new InvalidRequestError("scopes must be a non-empty array", "scopes", "missing_required_fields");
      }

      // Validate scopes
      for (const s of scopes) {
        if (!SCOPES.includes(s as any)) {
          throw new InvalidRequestError(`Invalid scope: ${s}`, "scopes", "invalid_scope");
        }
      }

      // Validate template_ids exist
      if (template_ids && Array.isArray(template_ids)) {
        for (const tid of template_ids) {
          const [tmpl] = await db
            .select({ id: templates.id })
            .from(templates)
            .where(and(eq(templates.id, tid), eq(templates.project_id, projectId)))
            .limit(1);
          if (!tmpl) {
            throw new InvalidRequestError(`Template not found: ${tid}`, "template_ids", "invalid_template_id");
          }
        }
      }

      // Validate callback_url (SSRF protection)
      if (callback_url) {
        try {
          await validateWebhookUrlWithDns(callback_url);
        } catch (err: any) {
          throw new InvalidRequestError(`Invalid callback URL: ${err.message}`, "callback_url", "invalid_callback_url");
        }
      }

      // Validate ip_allowlist entries (IP or CIDR, IPv4/IPv6)
      if (ip_allowlist && Array.isArray(ip_allowlist)) {
        for (const entry of ip_allowlist) {
          const check = parseIpOrCidr(entry);
          if (!check.ok) {
            throw new InvalidRequestError(
              `Invalid IP or CIDR: "${entry}" (${check.reason})`,
              "ip_allowlist",
              "invalid_ip_allowlist",
            );
          }
        }
      }

      // Generate API key
      const { raw, hash, prefix } = generateApiKey();

      const [row] = await db
        .insert(apiKeys)
        .values({
          id: generateId("api_key"),
          project_id: projectId,
          key_hash: hash,
          key_prefix: prefix,
          name,
          label: name,
          scopes,
          description: description || null,
          template_ids: template_ids || null,
          callback_url: callback_url || null,
          default_reviewer: default_reviewer || null,
          rate_limit_per_hour: rate_limit_per_hour || null,
          expires_at: expires_at ? new Date(expires_at) : null,
          ip_allowlist: ip_allowlist && ip_allowlist.length > 0 ? ip_allowlist : null,
        })
        .returning();

      // Tier 2 REQUIRED (services/AUDIT-WRITE-CONTRACT.md). An API key is a
      // decision-capable principal: with reviews:create it can demand oversight,
      // and with reviews:decide it can record decisions. The apiKeys row shows
      // the scopes the key holds NOW, but nothing else records who granted that
      // authority or when — so without this row a key's decisions trace back to
      // a principal of unknown provenance.
      //
      // `prefix` identifies the key; `raw` NEVER appears here. It is returned to
      // the caller exactly once, in the response body below, and the ledger must
      // not become a second place it can be read from.
      if (auditService) {
        await auditService.log({
          action: "api_key.created",
          actor: keyActor(req),
          resource_type: "api_key",
          resource_id: row.id,
          details: {
            key_prefix: prefix,
            name,
            scopes,
            template_ids: row.template_ids ?? null,
            rate_limit_per_hour: row.rate_limit_per_hour ?? null,
            expires_at: row.expires_at ? row.expires_at.toISOString() : null,
            ip_allowlist: row.ip_allowlist ?? null,
            has_callback_url: Boolean(row.callback_url),
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      // Strip key_hash from response
      const { key_hash, ...safe } = row;

      res.status(201).json({
        ...envelope("api_key", safe),
        raw_key: raw,
      });
    } catch (err) {
      next(err);
    }
  });

  // ─── Update API Key ───
  // PUT /api/v1/settings/api-keys/:id
  router.put("/:id", validate({ body: ApiKeyUpdateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const {
        name,
        description,
        scopes,
        template_ids,
        callback_url,
        default_reviewer,
        rate_limit_per_hour,
        is_active,
        expires_at,
        ip_allowlist,
      } = req.body;

      const updates: Record<string, any> = {};

      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (is_active !== undefined) updates.is_active = is_active;
      if (default_reviewer !== undefined) updates.default_reviewer = default_reviewer;
      if (rate_limit_per_hour !== undefined) updates.rate_limit_per_hour = rate_limit_per_hour;

      if (expires_at !== undefined) {
        updates.expires_at = expires_at === null ? null : new Date(expires_at);
      }

      if (ip_allowlist !== undefined) {
        if (Array.isArray(ip_allowlist)) {
          for (const entry of ip_allowlist) {
            const check = parseIpOrCidr(entry);
            if (!check.ok) {
              throw new InvalidRequestError(
                `Invalid IP or CIDR: "${entry}" (${check.reason})`,
                "ip_allowlist",
                "invalid_ip_allowlist",
              );
            }
          }
          updates.ip_allowlist = ip_allowlist.length > 0 ? ip_allowlist : null;
        } else {
          updates.ip_allowlist = null;
        }
      }

      // Validate scopes if provided
      if (scopes !== undefined) {
        if (!Array.isArray(scopes) || scopes.length === 0) {
          throw new InvalidRequestError("scopes must be a non-empty array", "scopes", "invalid_scope");
        }
        for (const s of scopes) {
          if (!SCOPES.includes(s as any)) {
            throw new InvalidRequestError(`Invalid scope: ${s}`, "scopes", "invalid_scope");
          }
        }
        updates.scopes = scopes;
      }

      // Validate template_ids if provided
      if (template_ids !== undefined) {
        if (template_ids !== null && Array.isArray(template_ids)) {
          for (const tid of template_ids) {
            const [tmpl] = await db
              .select({ id: templates.id })
              .from(templates)
              .where(and(eq(templates.id, tid), eq(templates.project_id, projectId)))
              .limit(1);
            if (!tmpl) {
              throw new InvalidRequestError(`Template not found: ${tid}`, "template_ids", "invalid_template_id");
            }
          }
        }
        updates.template_ids = template_ids;
      }

      // Validate callback_url if provided
      if (callback_url !== undefined) {
        if (callback_url !== null && callback_url !== "") {
          try {
            await validateWebhookUrlWithDns(callback_url);
          } catch (err: any) {
            throw new InvalidRequestError(`Invalid callback URL: ${err.message}`, "callback_url", "invalid_callback_url");
          }
        }
        updates.callback_url = callback_url;
      }

      const [updated] = await db
        .update(apiKeys)
        .set(updates)
        .where(
          and(
            eq(apiKeys.id, String(req.params.id)),
            eq(apiKeys.project_id, projectId),
          ),
        )
        .returning();

      if (!updated) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      // Tier 2 REQUIRED. This is the authority-change site: `scopes` widens or
      // narrows what the key may do, `template_ids` changes which templates it
      // reaches, and `is_active` switches the principal on or off. The row keeps
      // only the result, so an escalation followed by a quiet narrowing would
      // otherwise leave no trace that the key ever held the wider scope.
      if (auditService) {
        await auditService.log({
          action: "api_key.updated",
          actor: keyActor(req),
          resource_type: "api_key",
          resource_id: updated.id,
          details: {
            key_prefix: updated.key_prefix,
            changed_keys: Object.keys(updates),
            scopes: updated.scopes,
            template_ids: updated.template_ids ?? null,
            is_active: updated.is_active,
            rate_limit_per_hour: updated.rate_limit_per_hour ?? null,
            expires_at: updated.expires_at ? updated.expires_at.toISOString() : null,
            ip_allowlist: updated.ip_allowlist ?? null,
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      // Strip key_hash from response
      const { key_hash, ...safe } = updated;

      res.json(envelope("api_key", safe));
    } catch (err) {
      next(err);
    }
  });

  // ─── Delete API Key ───
  // DELETE /api/v1/settings/api-keys/:id
  router.delete("/:id", async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const [deleted] = await db
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.id, req.params.id),
            eq(apiKeys.project_id, projectId),
          ),
        )
        .returning();

      if (!deleted) {
        throw new NotFoundError("API key not found", "api_key_not_found");
      }

      // Tier 2 REQUIRED. A hard DELETE, not a soft revoke: after this the row is
      // gone, so this is the ONLY surviving record that the key existed, what
      // authority it held, and who destroyed it. Reviews it created still point
      // at a prefix that now resolves to nothing, and this row is what closes
      // that gap. Recorded with the scopes it held at the moment of removal.
      if (auditService) {
        await auditService.log({
          action: "api_key.revoked",
          actor: keyActor(req),
          resource_type: "api_key",
          resource_id: deleted.id,
          details: {
            key_prefix: deleted.key_prefix,
            name: deleted.name,
            scopes: deleted.scopes,
            template_ids: deleted.template_ids ?? null,
            was_active: deleted.is_active,
            ip: req.ip,
          },
          project_id: projectId,
        });
      }

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
