import { eq, and, inArray, sql } from "drizzle-orm";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId, InvalidRequestError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { deleteWithNoteAttachments } from "./note-cleanup";
import { isUniqueViolation } from "../lib/pg-error";

// Canonical slug shape, mirroring SlugSchema in
// packages/shared/src/api/schemas/templates.ts. Used by create() as
// defense-in-depth and by publish() as the authoritative gate on a promoted
// draft slug (the draft body schema is deliberately permissive — drafts may be
// partial and invalid — so publish is where a draft slug first meets a rule).
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function createTemplateService(db: AppDb) {
  return {
    async create(projectId: string, data: {
      slug: string;
      name: string;
      description?: string;
      fields: any[];
      actions: any[];
      default_priority?: string;
      enable_review_links?: boolean;
      auto_approve?: boolean;
      timeout_seconds?: number;
      timeout_action?: string;
      instructions?: string;
      chain_config?: Record<string, unknown> | null;
      allow_request_changes?: boolean;
      allow_notes?: boolean;
      allow_monitoring?: boolean;
      default_auth_level?: "public" | "email_otp" | "account";
      default_expiry_seconds?: number;
      max_iterations?: number | null;
      changes_timeout_hours?: number | null;
    }) {
      // Slug format is gated at the route layer via SlugSchema
      // (TemplateCreateBodySchema). Defense-in-depth check at the service
      // matches the same canonical regex so internal callers (seeds, tests,
      // future migrations) can't bypass it.
      if (!SLUG_PATTERN.test(data.slug)) {
        throw new InvalidRequestError("Slug must be lowercase alphanumeric with hyphens", "slug", "invalid_slug");
      }

      const [template] = await db.insert(templates).values({
        id: generateId("template"),
        slug: data.slug,
        project_id: projectId,
        name: data.name,
        description: data.description,
        fields: data.fields,
        actions: data.actions,
        default_priority: data.default_priority || "normal",
        enable_review_links: data.enable_review_links ?? false,
        auto_approve: data.auto_approve ?? false,
        timeout_seconds: data.timeout_seconds,
        timeout_action: data.timeout_action,
        instructions: data.instructions,
        chain_config: data.chain_config ?? null,
        allow_request_changes: data.allow_request_changes ?? true,
        allow_notes: data.allow_notes ?? true,
        allow_monitoring: data.allow_monitoring ?? false,
        // Spec section 8.5. DB defaults ('public' / 86400) match the column
        // defaults set by migration 039 — explicit pass-through here keeps
        // the wire contract honest when the caller sends a value.
        default_auth_level: data.default_auth_level ?? "public",
        default_expiry_seconds: data.default_expiry_seconds ?? 86400,
        // Template-level guardrails. Both nullable = "no cap"; the DB CHECK
        // (max_iterations >= 1) is the backstop behind the Zod range.
        max_iterations: data.max_iterations ?? null,
        changes_timeout_hours: data.changes_timeout_hours ?? null,
      }).returning();

      return template;
    },

    /**
     * Create a new template in draft status with initial content in draft_config.
     * Used by the UI "New template" flow — the row exists from the moment the
     * user clicks New, so edits can auto-save server-side without losing work.
     * Published columns hold placeholder defaults so the row is valid, but
     * agents can't create reviews against a draft template.
     */
    async createDraft(projectId: string, initial: Record<string, any> = {}) {
      const id = generateId("template");
      // Published columns get minimal safe defaults — they're overwritten on publish.
      // generateId returns base64url, so the raw id tail can contain uppercase,
      // `-` and `_` — none of which are legal in a slug. The placeholder used
      // to inherit that, producing rows like `draft-UaBOMWla` that no slug
      // validator would accept (harmless while the template is a draft and
      // refuses reviews, but it is still an invalid value sitting in the slug
      // column, and publish() now validates what it promotes).
      const placeholderSlug = `draft-${id.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;
      const [template] = await db.insert(templates).values({
        id,
        slug: initial.slug || placeholderSlug,
        project_id: projectId,
        name: initial.name || "Untitled template",
        fields: [],
        actions: [],
        status: "draft",
        draft_config: {
          name: initial.name || "",
          slug: initial.slug || "",
          description: initial.description || "",
          fields: initial.fields || [],
          actions: initial.actions || [],
          default_priority: initial.default_priority || "normal",
          ...initial,
        },
        draft_updated_at: new Date(),
      }).returning();
      return template;
    },

    async list(projectId: string) {
      const items = await db
        .select()
        .from(templates)
        .where(eq(templates.project_id, projectId))
        .orderBy(templates.created_at);
      return { items, total: items.length, has_more: false };
    },

    async getById(projectId: string, id: string) {
      const [template] = await db
        .select()
        .from(templates)
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .limit(1);
      return template || null;
    },

    async getBySlug(projectId: string, slug: string) {
      const [template] = await db
        .select()
        .from(templates)
        .where(and(eq(templates.slug, slug), eq(templates.project_id, projectId)))
        .limit(1);
      return template || null;
    },

    async update(projectId: string, id: string, data: Partial<{
      name: string;
      description: string;
      fields: any[];
      actions: any[];
      default_priority: string;
      enable_review_links: boolean;
      auto_approve: boolean;
      timeout_seconds: number;
      timeout_action: string;
      instructions: string;
      chain_config: Record<string, unknown> | null;
      allow_request_changes: boolean;
      allow_notes: boolean;
      allow_monitoring: boolean;
      default_auth_level: "public" | "email_otp" | "account";
      default_expiry_seconds: number;
      changes_timeout_hours: number | null;
      max_iterations: number | null;
    }>) {
      const [updated] = await db
        .update(templates)
        .set({ ...data, updated_at: new Date() })
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .returning();
      return updated || null;
    },

    async delete(projectId: string, id: string, options: { force?: boolean } = {}) {
      // Pre-fetch within project scope so we can return the row to callers
      // (existing contract) while routing the actual delete through
      // deleteWithNoteAttachments — cascades note_attachments rows in a
      // single tx (spec §6.6 / AC #14).
      const [existing] = await db
        .select()
        .from(templates)
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .limit(1);
      if (!existing) return null;

      // Block delete when in-flight reviews would be orphaned. reviews.template_id
      // is ON DELETE SET NULL (migration 013), so the rows survive but lose
      // their field/action schema — making them un-resolvable from the UI.
      // Pass { force: true } to override (used by admin tooling).
      if (!options.force) {
        const inflight = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(and(
            eq(reviews.template_id, id),
            inArray(reviews.status, ["pending", "awaiting_iteration", "awaiting_external"]),
          ));
        const count = inflight[0]?.c ?? 0;
        if (count > 0) {
          throw new InvalidRequestError(
            `Template has ${count} in-flight ${count === 1 ? "review" : "reviews"}. Resolve or archive them before deleting, or pass force=true.`,
            "template_id",
            "template_has_inflight_reviews",
          );
        }
      }

      await deleteWithNoteAttachments(db, "template", id);
      return existing;
    },

    /**
     * Upsert the draft_config for a template. Called on every edit keystroke
     * (debounced client-side). Never touches the published columns — agents
     * continue to see the old config until Publish is called.
     */
    async updateDraft(projectId: string, id: string, draftConfig: Record<string, any>) {
      const [updated] = await db
        .update(templates)
        .set({ draft_config: draftConfig, draft_updated_at: new Date(), updated_at: new Date() })
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .returning();
      return updated || null;
    },

    /**
     * Atomically promote draft_config into the published columns and clear it.
     * If the template is in draft status and has never been published, this is
     * the "first activation" — status flips to active too.
     *
     * Race-safe: acquires a row-level lock via SELECT FOR UPDATE, runs the
     * caller-supplied `validateDraft` against the locked draft, then writes
     * back the validated/normalized values in the same transaction. A
     * concurrent PATCH /:id/draft serializes behind the lock and either
     * (a) waits for publish to commit then writes to the now-empty draft
     * column, or (b) commits first and is then validated by this call.
     * Either way, the live config promoted here is exactly what
     * validateDraft saw.
     *
     * Note: publishing a template with pending reviews will change how those
     * reviews render their fields. A future snapshot-on-create patch will
     * isolate pending reviews from this.
     */
    async publish(
      projectId: string,
      id: string,
      validateDraft: (draft: Record<string, any>) => { fields: any[]; actions: any[] },
    ) {
      return await db.transaction(async (tx) => {
        const [tpl] = await tx
          .select()
          .from(templates)
          .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
          .for("update")
          .limit(1);
        if (!tpl) return null;
        if (!tpl.draft_config) return tpl; // nothing to publish

        const draft = tpl.draft_config as Record<string, any>;
        const { fields: validatedFields, actions: canonicalActions } = validateDraft(draft);

        const updateData: Record<string, any> = {
          draft_config: null,
          draft_updated_at: null,
          updated_at: new Date(),
          fields: validatedFields,
          actions: canonicalActions,
        };
        // Only copy other keys that exist in the draft — lets clients send partial drafts.
        // `slug` is deliberately NOT in this list: it is promoted below under a
        // stricter rule than a blind copy (see the slug block).
        const mappable = ["name", "description", "default_priority",
          "enable_review_links", "auto_approve", "timeout_seconds", "timeout_action",
          "changes_timeout_hours", "max_iterations", "instructions",
          "allow_request_changes", "allow_notes", "allow_monitoring",
          "default_auth_level", "default_expiry_seconds", "chain_config"];
        for (const key of mappable) {
          if (draft[key] !== undefined) updateData[key] = draft[key];
        }

        // Slug promotion. The editor exposes a slug input
        // while the template is a draft and locks it once live
        // (DetailEditConfig.tsx); `mappable` used to omit "slug" entirely, so
        // the input wrote into draft_config and was then discarded — every
        // UI-created template kept its `draft-xxxxxxxx` placeholder forever.
        //
        // Promotion is FIRST-PUBLISH-ONLY, and that is a correctness
        // requirement rather than a convenience: execute-action.ts resolves a
        // review's action vocabulary from the live template row BY SLUG via
        // reviews.template_slug, so renaming a live template would silently
        // strip every custom action from its in-flight reviews. A draft
        // template refuses review creation (crud.ts template_draft), so at
        // first publish there provably are no in-flight reviews to orphan.
        //
        // Evaluated against the FOR UPDATE-locked `tpl`, so the status check
        // cannot race a concurrent publish.
        const draftSlug = typeof draft.slug === "string" ? draft.slug.trim() : "";
        if (draftSlug && draftSlug !== tpl.slug) {
          if (tpl.status !== "draft") {
            throw new InvalidRequestError(
              `Slug cannot change after a template is published (this template is '${tpl.slug}'). Create a new template instead: in-flight reviews resolve their actions by slug and would lose them.`,
              "slug",
              "slug_immutable_after_publish",
            );
          }
          if (!SLUG_PATTERN.test(draftSlug)) {
            throw new InvalidRequestError(
              "Slug must be lowercase alphanumeric with hyphens",
              "slug",
              "invalid_slug",
            );
          }
          updateData.slug = draftSlug;
        }

        // First publish activates a draft template.
        if (tpl.status === "draft") updateData.status = "active";

        let updated;
        try {
          [updated] = await tx
            .update(templates)
            .set(updateData)
            .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
            .returning();
        } catch (err) {
          // Mirror the create route's translation of templates_project_id_slug_uniq
          // (migration 055) so a colliding first publish is a field-level 4xx
          // rather than a raw 500. Throwing here rolls the transaction back, so
          // the draft survives and the operator can pick another slug.
          if (isUniqueViolation(err, "templates_project_id_slug_uniq")) {
            throw new InvalidRequestError(
              `A template with slug '${updateData.slug}' already exists in this project.`,
              "slug",
              "slug_already_exists",
            );
          }
          throw err;
        }
        return updated || null;
      });
    },

    /** Discard the draft, leaving the published config untouched. */
    async discardDraft(projectId: string, id: string) {
      const [updated] = await db
        .update(templates)
        .set({ draft_config: null, draft_updated_at: null, updated_at: new Date() })
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .returning();
      return updated || null;
    },

    /** Pause: status=inactive. New agent review requests will be rejected. Pending reviews keep running. */
    async pause(projectId: string, id: string) {
      const [updated] = await db
        .update(templates)
        .set({ status: "inactive", updated_at: new Date() })
        .where(and(eq(templates.id, id), eq(templates.project_id, projectId)))
        .returning();
      return updated || null;
    },

    /** Resume: status=active. Only valid from inactive (not from draft — use publish for that). */
    async resume(projectId: string, id: string) {
      const [updated] = await db
        .update(templates)
        .set({ status: "active", updated_at: new Date() })
        .where(and(
          eq(templates.id, id),
          eq(templates.project_id, projectId),
          eq(templates.status, "inactive"),
        ))
        .returning();
      return updated || null;
    },
  };
}
