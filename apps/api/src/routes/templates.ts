import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { createTemplateService } from "../services/templates";
import { projects, templates as templatesTable } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import {
  envelope,
  listEnvelope,
  GatewerkError,
  InvalidRequestError,
  NotFoundError,
  TemplateCreateBodySchema,
  TemplateUpdateBodySchema,
  TemplateDraftCreateBodySchema,
  TemplateDraftUpdateBodySchema,
  normalizeTemplateActions,
  type TemplateActionConfig,
} from "@gatewerk/shared";
import { requireScope } from "../middleware/require-scope";
import { validate } from "../middleware/validate";
import { validateFields, normalizeAndValidateActions } from "../lib/template-validation";

// Mirrors the shape produced by the validate.ts middleware's ValidationError
// so /publish can surface 422 with the same {error.code, error.details[]}
// envelope when the draft re-validation fails. Used only by /publish; the
// route-time middleware handles the create/update paths directly.
class DraftValidationError extends GatewerkError {
  readonly details: Array<{ path: string; message: string; code: string }>;
  constructor(issues: import("zod").ZodIssue[]) {
    const details = issues.map((i) => ({
      path: ["body", ...i.path.map(String)].join("."),
      message: i.message,
      code: i.code ?? "invalid",
    }));
    const primary = details[0];
    super(
      `Invalid draft template defaults: ${primary?.message ?? "validation failed"}`,
      422,
      "invalid_request",
      "validation_failed",
      primary?.path,
    );
    this.name = "DraftValidationError";
    this.details = details;
  }
  toJSON() {
    const base = super.toJSON() as { error: Record<string, unknown> };
    base.error.details = this.details;
    return base;
  }
}

/**
 * Spec §11.2 canonical wire format: outbound template responses always
 * carry actions in the canonical TemplateActionConfig[] shape, regardless
 * of how the template's row is stored. Storage may be heterogeneous during
 * the v1.4 transition (legacy bare-string, legacy structured, canonical);
 * the read serializer normalizes uniformly. Returns a NEW object — does
 * NOT mutate the input row.
 */
function serializeTemplateForWire<T extends { actions?: unknown }>(template: T): T {
  return { ...template, actions: normalizeTemplateActions(template.actions) };
}

import { resolveProjectId } from "../lib/resolve-project-id";
import { isUniqueViolation } from "../lib/pg-error";

/**
 * Actor string for a template audit row. Matches the convention the
 * DELETE /:id handler already established in this file: a dashboard session is
 * `reviewer:<email>`, an API key is `agent:<prefix>`. Templates are the one
 * mutable surface both principal kinds can write, so the actor must say which.
 */
function templateActor(req: any): string {
  return req.reviewer
    ? `reviewer:${req.reviewer.email}`
    : `agent:${req.apiKeyPrefix || "unknown"}`;
}

/**
 * The template columns that decide an outcome rather than describe one. A
 * `template.updated` row is only useful to an auditor if it says what the policy
 * BECAME, so these are recorded by value, not merely named in `changed_keys`.
 *
 * `timeout_action` leads because it is the field that turns an expiry into an
 * auto-approval: set to "approve", every review that runs out the clock is
 * granted with no human present.
 */
const POLICY_KEYS = [
  "timeout_action",
  "timeout_seconds",
  "auto_approve",
  "actions",
  "chain_config",
  "default_auth_level",
  "default_expiry_seconds",
  "max_iterations",
  "changes_timeout_hours",
  "allow_request_changes",
  "allow_monitoring",
] as const;

/** The subset of `source` that is policy-bearing, for an audit `details` blob. */
function policySnapshot(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function createTemplateRoutes(db: AppDb, auditService?: any): Router {
  const router = Router();
  const service = createTemplateService(db);

  // POST /api/v1/templates — create template
  router.post("/", requireScope("templates:write"), validate({ body: TemplateCreateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new InvalidRequestError("No project found", undefined, "no_project");
      }

      const { slug, name, description, fields, actions, default_priority, enable_review_links, auto_approve, timeout_seconds, timeout_action, instructions, chain_config, allow_request_changes, allow_notes, allow_monitoring, default_auth_level, default_expiry_seconds, max_iterations, changes_timeout_hours } = req.body;

      if (!slug || !name || !fields) {
        throw new InvalidRequestError("Missing required fields: slug, name, fields", undefined, "missing_required_fields");
      }

      // Field validation
      const fieldResult = validateFields(fields);
      if (!fieldResult.valid) {
        throw new InvalidRequestError(fieldResult.error!, "fields", "invalid_fields");
      }

      // Action validation + normalization (spec §7.1 + §11.2 lazy write-back).
      // Throws InvalidRequestError on §7.1 violation with a stable error code.
      const canonicalActions = normalizeAndValidateActions(actions);

      // Timeout validation
      if (timeout_seconds !== undefined && timeout_seconds !== null) {
        if (typeof timeout_seconds !== "number" || timeout_seconds < 60) {
          throw new InvalidRequestError("Timeout must be at least 60 seconds.", "timeout_seconds", "invalid_timeout");
        }
      }

      let template;
      try {
        template = await service.create(projectId, {
          slug, name, description, fields,
          actions: canonicalActions,
          default_priority, enable_review_links,
          auto_approve: auto_approve || false,
          timeout_seconds, timeout_action, instructions,
          chain_config: chain_config ?? null,
          allow_request_changes: allow_request_changes ?? true,
          allow_notes: allow_notes ?? true,
          allow_monitoring: allow_monitoring ?? false,
          default_auth_level,
          default_expiry_seconds,
          // Both had a column, a CHECK, Zod, and a read side, but
          // previously no write path through this route.
          max_iterations,
          changes_timeout_hours,
        });
      } catch (err) {
        // Surface the (project_id, slug) unique constraint as a clean 4xx.
        // Migration 055 introduced templates_project_id_slug_uniq.
        // Read through drizzle's DrizzleQueryError wrapper — see lib/pg-error.ts;
        // the direct `err.code` read this used to do never matched.
        if (isUniqueViolation(err, "templates_project_id_slug_uniq")) {
          throw new InvalidRequestError(
            `A template with slug '${slug}' already exists in this project.`,
            "slug",
            "slug_already_exists",
          );
        }
        throw err;
      }

      // Tier 2 REQUIRED (AUDIT-WRITE-CONTRACT.md): the templates row is
      // durable, but only this row records who introduced the policy and what
      // it was at creation, which is what a decision made under it is judged by.
      if (auditService) {
        await auditService.log({
          action: "template.created",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: {
            slug: template.slug,
            name: template.name,
            ...policySnapshot(template as unknown as Record<string, unknown>),
          },
          project_id: projectId,
        });
      }

      res.status(201).json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/templates — list templates
  router.get("/", requireScope("templates:read"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }
      const result = await service.list(projectId);

      // If API key has template scoping, filter to allowed templates only
      const templateIds: string[] | null = (req as any).templateIds;
      let items = result.items;
      if (templateIds !== null && templateIds !== undefined && Array.isArray(templateIds)) {
        items = items.filter((t: any) => templateIds.includes(t.id));
      }

      res.json(
        listEnvelope(
          "template",
          items.map(serializeTemplateForWire),
          { has_more: result.has_more, total: items.length },
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/templates/:id — get template by ID
  router.get("/:id", requireScope("templates:read"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }
      const template = await service.getById(projectId, String(req.params.id));
      if (!template) {
        throw new NotFoundError("Template not found", "template_not_found");
      }
      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/templates/:id — update template
  router.put("/:id", requireScope("templates:write"), validate({ body: TemplateUpdateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }

      const { name, description, fields, actions, default_priority, enable_review_links, auto_approve, timeout_seconds, timeout_action, instructions, changes_timeout_hours, chain_config, allow_request_changes, allow_notes, allow_monitoring, default_auth_level, default_expiry_seconds, max_iterations } = req.body;

      // Field validation (if fields provided)
      if (fields !== undefined) {
        const fieldResult = validateFields(fields);
        if (!fieldResult.valid) {
          throw new InvalidRequestError(fieldResult.error!, "fields", "invalid_fields");
        }
      }

      // Action validation + normalization (if actions provided).
      // PATCH semantic: undefined leaves actions untouched; empty array
      // resets to default presets per spec §3.3.
      let normalizedActions: TemplateActionConfig[] | undefined;
      if (actions !== undefined) {
        normalizedActions = normalizeAndValidateActions(actions);
      }

      // Timeout validation
      if (timeout_seconds !== undefined && timeout_seconds !== null) {
        if (typeof timeout_seconds !== "number" || timeout_seconds < 60) {
          throw new InvalidRequestError("Timeout must be at least 60 seconds.", "timeout_seconds", "invalid_timeout");
        }
      }

      const updateData: Record<string, any> = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (fields !== undefined) updateData.fields = fields;
      if (normalizedActions !== undefined) updateData.actions = normalizedActions;
      if (default_priority !== undefined) updateData.default_priority = default_priority;
      if (enable_review_links !== undefined) updateData.enable_review_links = enable_review_links;
      if (auto_approve !== undefined) updateData.auto_approve = auto_approve;
      if (timeout_seconds !== undefined) updateData.timeout_seconds = timeout_seconds ?? null;
      if (timeout_action !== undefined) updateData.timeout_action = timeout_action ?? null;
      if (instructions !== undefined) updateData.instructions = instructions ?? null;
      if (changes_timeout_hours !== undefined) updateData.changes_timeout_hours = changes_timeout_hours ?? null;
      // Same PATCH semantic as the rest of this handler. Absent from the
      // destructure until S1, so the only way to set a template-level
      // iteration cap was direct SQL.
      if (max_iterations !== undefined) updateData.max_iterations = max_iterations ?? null;
      // PATCH semantics: undefined leaves the column untouched, null clears it,
      // an object replaces. Zod already validated the shape via
      // ChainDefinitionSchema (refinements: cycle prevention, OSS feature gate,
      // step-id uniqueness). The route only marshals through.
      if (chain_config !== undefined) updateData.chain_config = chain_config ?? null;
      if (allow_request_changes !== undefined) updateData.allow_request_changes = allow_request_changes;
      if (allow_notes !== undefined) updateData.allow_notes = allow_notes;
      if (allow_monitoring !== undefined) updateData.allow_monitoring = allow_monitoring;
      // Spec section 8.5. PATCH semantic mirrors the rest of this handler:
      // undefined leaves the column untouched; explicit value updates it.
      // Zod (TemplateUpdateBodySchema) gates the enum + range; storage CHECK
      // (migration 039) is the defense-in-depth backstop.
      if (default_auth_level !== undefined) updateData.default_auth_level = default_auth_level;
      if (default_expiry_seconds !== undefined) updateData.default_expiry_seconds = default_expiry_seconds;

      const template = await service.update(projectId, String(req.params.id), updateData);
      if (!template) {
        throw new NotFoundError("Template not found", "template_not_found");
      }

      // Tier 2 REQUIRED. `changed_keys` is the full PATCH surface; the policy
      // keys are additionally recorded by value so the ledger can answer "what
      // was the policy at the time this review was decided", which is the whole
      // reason a config change is auditable at all.
      if (auditService) {
        await auditService.log({
          action: "template.updated",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: {
            slug: template.slug,
            changed_keys: Object.keys(updateData),
            ...policySnapshot(updateData),
          },
          project_id: projectId,
        });
      }

      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/templates/draft — create a new draft template (empty or with initial content)
  // Used by the "New template" button. Row exists immediately so edits auto-save.
  router.post("/draft", requireScope("templates:write"), validate({ body: TemplateDraftCreateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new InvalidRequestError("No project found", undefined, "no_project");
      const template = await service.createDraft(projectId, req.body || {});
      // Tier 2 REQUIRED. A draft cannot yet decide anything, but it is the row
      // /publish promotes, so the ledger needs the point at which it appeared.
      if (auditService) {
        await auditService.log({
          action: "template.created",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: { slug: template.slug, status: template.status, draft: true },
          project_id: projectId,
        });
      }
      res.status(201).json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // PATCH /api/v1/templates/:id/draft — upsert draft_config (debounced auto-save from client)
  //
  // DELIBERATELY NOT AUDITED, stated here so this reads as a decision and not
  // as the oversight it would otherwise be indistinguishable from. Volume: this
  // is the editor's 600ms debounced autosave (TemplateDetail.tsx), so one
  // editing session emits dozens to hundreds of awaited, lock-holding writes —
  // more rows for one config edit than a day of real decisions. AUDIT_ACTIONS
  // sets this precedent at `email.tenant_paused`. Semantics: draft_config
  // governs nothing; reviews are decided against the PUBLISHED columns, and the
  // transition where a draft becomes policy is /publish, which IS audited with
  // the promoted keys. Discard is audited too. Only keystrokes are lost.
  router.patch("/:id/draft", requireScope("templates:write"), validate({ body: TemplateDraftUpdateBodySchema }), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new NotFoundError("No project found", "project_not_found");
      const template = await service.updateDraft(projectId, String(req.params.id), req.body || {});
      if (!template) throw new NotFoundError("Template not found", "template_not_found");
      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // POST /api/v1/templates/:id/publish — promote draft_config into published
  // columns atomically. All validation runs INSIDE the publish transaction
  // (after the row-level lock), so a concurrent PATCH /:id/draft can't slip
  // unvalidated content into the live config between validation and write.
  router.post("/:id/publish", requireScope("templates:write"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new NotFoundError("No project found", "project_not_found");

      // Pre-flight existence check (gives a clean 404 before we open a tx).
      // The atomic version inside service.publish() is what actually gates
      // the write, but failing fast here keeps the common 404 cheap.
      const [existing] = await db.select().from(templatesTable)
        .where(and(eq(templatesTable.id, String(req.params.id)), eq(templatesTable.project_id, projectId)))
        .limit(1);
      if (!existing) throw new NotFoundError("Template not found", "template_not_found");
      if (!existing.draft_config) throw new InvalidRequestError("No draft to publish", undefined, "no_draft");

      const template = await service.publish(projectId, String(req.params.id), (draft) => {
        const finalFields = draft.fields !== undefined ? draft.fields : existing.fields;
        const finalActions = draft.actions !== undefined ? draft.actions : existing.actions;

        const fieldResult = validateFields(finalFields);
        if (!fieldResult.valid) throw new InvalidRequestError(fieldResult.error!, "fields", "invalid_fields");

        const canonicalActions = normalizeAndValidateActions(finalActions);

        if (draft.timeout_seconds !== undefined && draft.timeout_seconds !== null) {
          if (typeof draft.timeout_seconds !== "number" || draft.timeout_seconds < 60) {
            throw new InvalidRequestError("Timeout must be at least 60 seconds.", "timeout_seconds", "invalid_timeout");
          }
        }

        // Defense-in-depth: re-validate spec §8.5 defaults via Zod so a
        // CHECK-constraint violation surfaces as a 422 with field-level
        // details instead of a raw 500.
        const draftDefaultsCheck = TemplateUpdateBodySchema.safeParse({
          default_auth_level: draft.default_auth_level,
          default_expiry_seconds: draft.default_expiry_seconds,
        });
        if (!draftDefaultsCheck.success) {
          throw new DraftValidationError(draftDefaultsCheck.error.issues);
        }

        return { fields: finalFields, actions: canonicalActions };
      });
      if (!template) throw new NotFoundError("Template not found", "template_not_found");

      // Tier 2 REQUIRED. This is the transition where a draft BECOMES the
      // policy reviews are decided under, so it is the row an auditor reads to
      // establish what the policy was from this instant onward. Recorded after
      // the publish transaction commits: an audit row for a rolled-back publish
      // would assert a policy that never took effect.
      if (auditService) {
        await auditService.log({
          action: "template.updated",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: {
            operation: "publish",
            slug: template.slug,
            first_publish: existing.status === "draft",
            promoted_keys: Object.keys(
              (existing.draft_config ?? {}) as Record<string, unknown>,
            ),
            ...policySnapshot(template as unknown as Record<string, unknown>),
          },
          project_id: projectId,
        });
      }

      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // DELETE /api/v1/templates/:id/draft — discard unpublished changes
  router.delete("/:id/draft", requireScope("templates:write"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new NotFoundError("No project found", "project_not_found");
      const template = await service.discardDraft(projectId, String(req.params.id));
      if (!template) throw new NotFoundError("Template not found", "template_not_found");
      // Tier 2 REQUIRED. Discard destroys draft_config outright, so once it
      // runs nothing in the schema records that a pending config change existed
      // or who threw it away.
      if (auditService) {
        await auditService.log({
          action: "template.updated",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: { operation: "draft_discarded", slug: template.slug },
          project_id: projectId,
        });
      }
      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // POST /api/v1/templates/:id/pause — status=inactive (reject new review requests)
  router.post("/:id/pause", requireScope("templates:write"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new NotFoundError("No project found", "project_not_found");
      const template = await service.pause(projectId, String(req.params.id));
      if (!template) throw new NotFoundError("Template not found", "template_not_found");
      // Tier 2 REQUIRED. Pausing makes the template reject new review requests:
      // from here on an agent's oversight request fails, so an investigation
      // into "why did nothing get reviewed" needs the who and when.
      if (auditService) {
        await auditService.log({
          action: "template.updated",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: { operation: "pause", slug: template.slug, status: template.status },
          project_id: projectId,
        });
      }
      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // POST /api/v1/templates/:id/resume — status=active (only from inactive).
  // service.resume() uses a status='inactive' WHERE filter so callers can't
  // transition a draft directly to active (publish is the only path that
  // promotes a draft, since it also validates fields/actions).
  router.post("/:id/resume", requireScope("templates:write"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) throw new NotFoundError("No project found", "project_not_found");
      const template = await service.resume(projectId, String(req.params.id));
      if (!template) {
        const existing = await service.getById(projectId, String(req.params.id));
        if (!existing) throw new NotFoundError("Template not found", "template_not_found");
        throw new InvalidRequestError(
          `Template is ${existing.status}; only inactive templates can be resumed`,
          "status",
          "invalid_template_state",
        );
      }
      // Tier 2 REQUIRED. Resume puts the template back in service under whatever
      // policy it currently holds, which may not be the policy it was paused
      // with. The pause / resume pair bounds the window in which no review could
      // be requested at all.
      if (auditService) {
        await auditService.log({
          action: "template.updated",
          actor: templateActor(req),
          resource_type: "template",
          resource_id: template.id,
          details: { operation: "resume", slug: template.slug, status: template.status },
          project_id: projectId,
        });
      }
      res.json(envelope("template", serializeTemplateForWire(template)));
    } catch (err) { next(err); }
  });

  // DELETE /api/v1/templates/:id — delete template
  router.delete("/:id", requireScope("templates:write"), async (req, res, next) => {
    try {
      const projectId = await resolveProjectId(req, db);
      if (!projectId) {
        throw new NotFoundError("No project found", "project_not_found");
      }
      const force = req.query.force === "true" || req.query.force === "1";
      const template = await service.delete(projectId, String(req.params.id), { force });
      if (!template) {
        throw new NotFoundError("Template not found", "template_not_found");
      }

      // Audit log
      if (auditService) {
        const actor = (req as any).reviewer
          ? `reviewer:${(req as any).reviewer.email}`
          : `agent:${(req as any).apiKeyPrefix || "unknown"}`;
        auditService.log({
          action: "template.deleted",
          actor,
          resource_type: "template",
          resource_id: template.id,
          details: { slug: template.slug },
          project_id: projectId,
        }).catch(() => {});
      }

      res.json(envelope("template", { id: template.id, deleted: true }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
