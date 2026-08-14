import { eq, and, or, desc, sql, inArray } from "drizzle-orm";
import { reviews, reviewVersions, templates } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  normalizeTemplateActions,
  ITERATION_STATUSES,
  isIterationStatus,
} from "@gatewerk/shared";
import type { AssignmentLadder } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { downloadAndStore, decodeAndStore, isMediaUrl, isBase64Media } from "../media";
import { initLadder } from "../assignment-ladder";
import { deleteWithNoteAttachments } from "../note-cleanup";
import { redactPrivateBody } from "../notes-visibility";
import { findReview, normalizeTemplateFields } from "./_queries";

// Inline-note row shape returned by the jsonb_agg subquery in
// getByIdWithTemplate. Matches the public /api/v1/notes wire shape minus the
// attachments enrichment (Phase A returns an empty placeholder; consumers
// re-fetch attachments via /api/v1/notes when needed). Visibility is enforced
// at the SQL layer (`is_shared = TRUE OR author_id = $subjectUser`) and
// redactPrivateBody runs over the rows as defense-in-depth.
type InlineNoteRow = {
  id: string;
  project_id: string;
  author_id: string | null;
  author_display_fallback: string | null;
  body: string;
  tags: string[];
  is_shared: boolean;
  created_at: string;
  updated_at: string;
  attachments: unknown[];
};

// Active-token projection. The latest live (un-used, un-revoked, un-expired)
// review_tokens row, surfaced read-only on review.get and review.list so the
// Inbox right pane can render token state without a follow-up round-trip.
// review_tokens.expires_at is NOT NULL so the filter uses a strict `> NOW()`
// — no IS NULL branch needed. Index review_tokens_review_id_created_at_idx
// covers the WHERE + ORDER BY → single B-tree probe per row.
type ActiveTokenRow = {
  id: string;
  recipient_label: string;
  auth_level: string;
  created_at: string;
  expires_at: string;
  opened_at: string | null;
};

export function createReviewCrudSlice(db: AppDb) {
  return {
    async create(projectId: string, data: {
      template: string;
      payload: Record<string, unknown>;
      callback_url?: string;
      priority?: string;
      actions?: string[];
      confidence?: number;
      irreversibility?: string;
      oversight?: string;
      assignee?: string;
      metadata?: Record<string, unknown>;
      timeout?: { action?: string; seconds: number };
      assignment_ladder?: AssignmentLadder;
      idempotency_key?: string;
      trace_url?: string;
      max_iterations?: number;
    }) {
      // Resolve by slug OR id. Slug is the portable handle and stays the one
      // we recommend, because "email-review" means the same thing in dev and
      // in prod while an id does not. But GET /api/v1/templates hands callers
      // a gw_tpl_ id as the row's `id`, and this used to reject that value
      // with template_not_found, an error claiming a template that plainly
      // existed could not be found. We handed out the identifier, so we accept
      // it back.
      //
      // Both arms stay scoped to projectId, so accepting ids does not widen
      // what an API key can reach.
      const candidates = await db
        .select()
        .from(templates)
        .where(
          and(
            or(eq(templates.slug, data.template), eq(templates.id, data.template)),
            eq(templates.project_id, projectId),
          ),
        )
        .limit(2);

      // A slug is free text, so one project could in principle hold a template
      // whose slug equals another's id. Prefer the slug match so the resolution
      // is deterministic rather than whichever row the planner returned first.
      const tpl = candidates.find((t) => t.slug === data.template) ?? candidates[0];

      if (!tpl) {
        throw new InvalidRequestError(
          `Template '${data.template}' not found in this project. Templates are addressed by slug or id.`,
          "template",
          "template_not_found",
        );
      }

      if (tpl.status === "draft") {
        throw new InvalidRequestError(
          `Template '${data.template}' is in draft status and cannot accept reviews. Activate the template first.`,
          "template",
          "template_draft",
        );
      }
      if (tpl.status === "inactive") {
        throw new InvalidRequestError(
          `Template '${data.template}' is inactive and cannot accept reviews.`,
          "template",
          "template_inactive",
        );
      }

      const timeoutSec = data.timeout?.seconds || tpl.timeout_seconds;
      let expires_at: Date | undefined;
      if (timeoutSec) {
        expires_at = new Date(Date.now() + timeoutSec * 1000);
      }

      // Service-seam invariant (not just route-gate defense): a monitoring
      // review without a window is a permanent zombie — the worker never
      // claims it and the veto CAS never matches. Refuse here so NO caller
      // of create() can produce one, gate or no gate.
      if (data.oversight === "monitoring" && !expires_at) {
        throw new InvalidRequestError(
          "Monitoring gates require a veto window: supply timeout.seconds or set a timeout default on the template.",
          "timeout",
          "monitoring_requires_timeout",
        );
      }

      const processedPayload = { ...data.payload };
      const tplFields = tpl.fields as Array<{ name: string; type: string }>;
      const mediaFields = tplFields.filter(f => f.type === "image" || f.type === "video");

      // Minted before the media loop so uploads are keyed by the real review
      // from the start. They used to be stored under the literal id "pending"
      // and moved afterwards, but the move only ever handled the local-disk
      // path: in cloud mode the object stayed at media/pending/<field><ext>
      // forever. That key is shared by every org and every concurrent create
      // using the same field name, so uploads overwrote each other across
      // tenants, the guessable path was served by the unauthenticated
      // /api/v1/media route, and nothing could attribute the object back to a
      // review or an org to delete it. generateId is pure, so hoisting it
      // costs nothing.
      const reviewId = generateId("review");

      for (const field of mediaFields) {
        const value = processedPayload[field.name];
        if (isMediaUrl(value)) {
          const stored = await downloadAndStore(value, reviewId, field.name);
          if (stored) {
            processedPayload[field.name] = stored.stored_path;
            processedPayload[`_media_${field.name}`] = stored;
          }
        } else if (isBase64Media(value)) {
          const stored = await decodeAndStore(value, reviewId, field.name);
          if (stored) {
            processedPayload[field.name] = stored.stored_path;
            processedPayload[`_media_${field.name}`] = stored;
          }
        }
      }

      // Ladder init precedence: when a ladder is supplied, `ladder[0].actor`
      // is the canonical initial assignee and overrides any caller-supplied
      // `assignee` (the same actor shows up in both via `initLadder.assignee`).
      // We fix `created_at` explicitly here so the arithmetic in
      // `ladder_next_promote_at` aligns with the row's actual timestamp —
      // the schema default uses NOW() which would drift a few ms from the
      // `new Date()` we capture here.
      const createdAt = new Date();
      const ladderInit = data.assignment_ladder
        ? initLadder(data.assignment_ladder, createdAt)
        : null;

      // P8 snapshot (073): normalized fields captured at creation — edits/deletes don't affect in-flight reviews.
      const snapshotFields = normalizeTemplateFields(tpl.fields);

      const [review] = await db.insert(reviews).values({
        id: reviewId,
        project_id: projectId,
        template_id: tpl.id,
        template_slug: tpl.slug,
        template_fields: snapshotFields,
        payload: processedPayload,
        suggested_value: processedPayload,
        callback_url: data.callback_url,
        priority: data.priority || tpl.default_priority || "normal",
        actions: data.actions || tpl.actions || ["approve", "reject"],
        confidence: data.confidence,
        irreversibility: data.irreversibility,
        assignee: ladderInit ? ladderInit.assignee : data.assignee,
        metadata: data.metadata,
        // Template-default inheritance. Both of these used to
        // read only from `data`, so a template configured "24h -> auto_approve"
        // produced a review with timeout_action = NULL, and processOne's
        // `review.timeout_action || "expire"` fallback then EXPIRED it. The
        // operator configured one behaviour and silently got another, with no
        // error anywhere. The chain path has always inherited both
        // (chain-engine.ts materializeStep); the two creation paths now agree.
        //
        // Monitoring keeps its hard NULL: a monitoring window lapses to
        // 'confirmed' via the monitoring sweep, and any non-null
        // timeout_action would let processExpired decide the review first.
        timeout_action: data.oversight === "monitoring" ? null : (data.timeout?.action ?? tpl.timeout_action),
        // Persist the value expires_at was actually derived from (timeoutSec
        // above) so the row cannot disagree with its own window.
        timeout_seconds: timeoutSec,
        expires_at,
        status: data.oversight === "monitoring" ? "monitoring" : "pending",
        oversight: data.oversight === "monitoring" ? "monitoring" : "blocking",
        current_version: 1,
        assignment_ladder: ladderInit ? ladderInit.ladder : undefined,
        ladder_index: ladderInit ? 0 : undefined,
        ladder_next_promote_at: ladderInit ? ladderInit.ladder_next_promote_at : undefined,
        created_at: ladderInit ? createdAt : undefined,
        idempotency_key: data.idempotency_key,
        trace_url: data.trace_url,
        // max_iterations: per-review value takes precedence, falls back to
        // template-level default, then null (no cap).
        max_iterations: data.max_iterations ?? tpl.max_iterations ?? null,
      }).returning();

      // The pending-directory rename that used to sit here is gone: media is
      // written under review.id in the first place now, so there is nothing to
      // move and no stored_path to rewrite.

      await db.insert(reviewVersions).values({
        id: generateId("version"),
        review_id: review.id,
        version: 1,
        payload: review.payload,
      });

      // Belt-and-suspenders: the monitoring gate already rejected auto_approve
      // templates for monitoring reviews; this guard makes the invariant
      // explicit at the service layer so a future refactor can't bypass it.
      if (tpl.auto_approve && data.oversight !== "monitoring") {
        const [autoApproved] = await db
          .update(reviews)
          .set({
            status: "decided",
            decision: "approved",
            decided_by: "system/auto-approve",
            decided_at: new Date(),
            action_value: "auto_approve",
            action_label: "Auto-approved",
            approved_value: data.payload,
            updated_at: new Date(),
          })
          .where(eq(reviews.id, review.id))
          .returning();

        return { ...autoApproved, auto_approved: true };
      }

      return review;
    },

    async list(projectId: string | null, filters?: {
      status?: string;
      priority?: string;
      template?: string;
      assignee?: string;
      limit?: number;
      offset?: number;
    }) {
      const conditions = [];
      if (projectId) {
        conditions.push(eq(reviews.project_id, projectId));
      }

      if (filters?.status) {
        // Inbound status filter alias (spec §11.3). After migration 033,
        // ITERATION_STATUSES collapsed to ['awaiting_iteration'] (canonical-
        // only storage). The legacy 'changes_requested' value is still
        // accepted as a deprecated INPUT alias for one minor version — the
        // ReviewListQueryStatusFilterInputSchema schema-permits it on the
        // wire; here we translate it to the canonical filter so any legacy
        // SDK consumer continues to see the iteration rows. Removed in v2.0
        // when 'changes_requested' is no longer accepted at any layer.
        if (
          isIterationStatus(filters.status) ||
          filters.status === "changes_requested"
        ) {
          conditions.push(inArray(reviews.status, ITERATION_STATUSES));
        } else {
          conditions.push(eq(reviews.status, filters.status));
        }
      }
      if (filters?.priority) {
        conditions.push(eq(reviews.priority, filters.priority));
      }
      if (filters?.template) {
        conditions.push(eq(reviews.template_slug, filters.template));
      }
      if (filters?.assignee) {
        conditions.push(eq(reviews.assignee, filters.assignee));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = Math.min(filters?.limit || 50, 100);
      const offset = filters?.offset || 0;

      // Items + count run in parallel — they share the same whereClause and don't depend
      // on each other. Halves round-trip latency vs the prior serial pattern.
      // leftJoin templates so each row carries its template metadata in-band.
      const activeTokenAgg = sql<ActiveTokenRow | null>`(
        SELECT jsonb_build_object(
          'id', t.id,
          'recipient_label', t.recipient_label,
          'auth_level', t.auth_level,
          'created_at', t.created_at,
          'expires_at', t.expires_at,
          'opened_at', t.opened_at
        )
        FROM review_tokens t
        WHERE t.review_id = ${reviews.id}
          AND t.used_at IS NULL
          AND t.revoked_at IS NULL
          AND t.is_preview = false
          AND t.expires_at > NOW()
        ORDER BY t.created_at DESC
        LIMIT 1
      )`.as("active_token");

      const chainStepNumber = sql<number | null>`(
        SELECT cs.step_number
        FROM chain_steps cs
        WHERE cs.id = ${reviews.chain_step_id}
      )`.as("chain_step_number");

      const chainTotalSteps = sql<number | null>`(
        SELECT COUNT(*)::int
        FROM chain_steps cs
        WHERE cs.chain_run_id = ${reviews.chain_run_id}
      )`.as("chain_total_steps");

      const itemsPromise = db
        .select({
          review: reviews,
          template: {
            id: templates.id,
            slug: templates.slug,
            name: templates.name,
            fields: templates.fields,
            actions: templates.actions,
            auto_approve: templates.auto_approve,
            instructions: templates.instructions,
            allow_request_changes: templates.allow_request_changes,
            allow_notes: templates.allow_notes,
            allow_monitoring: templates.allow_monitoring,
            enable_review_links: templates.enable_review_links,
          },
          active_token: activeTokenAgg,
          chain_step_number: chainStepNumber,
          chain_total_steps: chainTotalSteps,
        })
        .from(reviews)
        .leftJoin(templates, eq(reviews.template_id, templates.id))
        .where(whereClause)
        .orderBy(
          sql`CASE ${reviews.priority}
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END ASC`,
          desc(reviews.created_at)
        )
        .limit(limit + 1)
        .offset(offset);

      const countPromise = db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(reviews)
        .where(whereClause);

      const [rows, countRows] = await Promise.all([itemsPromise, countPromise]);
      const count = countRows[0]?.count ?? 0;

      const has_more = rows.length > limit;
      const slice = has_more ? rows.slice(0, limit) : rows;

      const items = slice.map(({ review, template, active_token, chain_step_number, chain_total_steps }) => {
        if (!template || template.id === null) {
          return { ...review, template: null, active_token, chain_step_number, chain_total_steps };
        }
        // P8: snapshot wins; live template is the fallback for legacy rows.
        const enrichedFields = normalizeTemplateFields(review.template_fields ?? template.fields);
        return {
          ...review,
          template: {
            id: template.id,
            slug: template.slug,
            name: template.name,
            fields: enrichedFields,
            // §11.2 canonical wire format: outbound actions are always the
            // canonical TemplateActionConfig[] shape regardless of how the
            // template's row is stored. Storage may be heterogeneous during
            // the v1.4 transition (legacy bare-string, legacy structured,
            // canonical); the read serializer normalizes uniformly.
            actions: normalizeTemplateActions(template.actions),
            auto_approve: template.auto_approve,
            instructions: template.instructions,
            allow_request_changes: template.allow_request_changes,
            allow_notes: template.allow_notes,
            allow_monitoring: template.allow_monitoring,
            enable_review_links: template.enable_review_links,
          },
          active_token,
          chain_step_number,
          chain_total_steps,
        };
      });

      return { items, total: count, has_more };
    },

    getById(projectId: string, id: string) {
      return findReview(db, projectId, id);
    },

    async getByIdWithTemplate(
      projectId: string,
      id: string,
      subjectUser: string | null = null,
    ) {
      // Single leftJoin round-trip — review + template metadata + inline notes
      // in one query (AC #10). template is null when review.template_id is
      // absent OR when the referenced template row is gone (soft-deleted).
      // The notes subquery filters by visibility at the SQL layer so private
      // notes never reach a non-author subject. `subjectUser = null` (api_key
      // caller) collapses the predicate to shared-only.
      const notesAgg = sql<InlineNoteRow[]>`COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', n.id,
            'project_id', n.project_id,
            'author_id', n.author_id,
            'author_display_fallback', n.author_display_fallback,
            'body', n.body,
            'tags', n.tags,
            'is_shared', n.is_shared,
            'created_at', n.created_at,
            'updated_at', n.updated_at,
            'attachments', '[]'::jsonb
          )
          ORDER BY n.created_at DESC
        )
        FROM notes n
        INNER JOIN note_attachments na ON na.note_id = n.id
        WHERE na.target_kind = 'review'
          AND na.target_id = ${reviews.id}
          AND n.deleted_at IS NULL
          AND (n.is_shared = TRUE OR n.author_id = ${subjectUser})
      ), '[]'::jsonb)`.as("notes");

      const activeTokenAgg = sql<ActiveTokenRow | null>`(
        SELECT jsonb_build_object(
          'id', t.id,
          'recipient_label', t.recipient_label,
          'auth_level', t.auth_level,
          'created_at', t.created_at,
          'expires_at', t.expires_at,
          'opened_at', t.opened_at
        )
        FROM review_tokens t
        WHERE t.review_id = ${reviews.id}
          AND t.used_at IS NULL
          AND t.revoked_at IS NULL
          AND t.is_preview = false
          AND t.expires_at > NOW()
        ORDER BY t.created_at DESC
        LIMIT 1
      )`.as("active_token");

      const chainStepNumber = sql<number | null>`(
        SELECT cs.step_number
        FROM chain_steps cs
        WHERE cs.id = ${reviews.chain_step_id}
      )`.as("chain_step_number");

      const chainTotalSteps = sql<number | null>`(
        SELECT COUNT(*)::int
        FROM chain_steps cs
        WHERE cs.chain_run_id = ${reviews.chain_run_id}
      )`.as("chain_total_steps");

      const [row] = await db
        .select({
          review: reviews,
          template: {
            id: templates.id,
            slug: templates.slug,
            name: templates.name,
            fields: templates.fields,
            actions: templates.actions,
            auto_approve: templates.auto_approve,
            instructions: templates.instructions,
            allow_request_changes: templates.allow_request_changes,
            allow_notes: templates.allow_notes,
            allow_monitoring: templates.allow_monitoring,
            enable_review_links: templates.enable_review_links,
          },
          notes: notesAgg,
          active_token: activeTokenAgg,
          chain_step_number: chainStepNumber,
          chain_total_steps: chainTotalSteps,
        })
        .from(reviews)
        .leftJoin(templates, eq(reviews.template_id, templates.id))
        .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId)))
        .limit(1);

      if (!row) return null;

      const { review, template, active_token, chain_step_number, chain_total_steps } = row;
      // Defense-in-depth: the SQL filter has already excluded non-visible
      // private notes, but redactPrivateBody runs over the result as a
      // belt-and-suspenders measure (matches /api/v1/notes response path).
      const inlineNotes = (row.notes ?? []).map((n) =>
        redactPrivateBody(n, { subject_user_id: subjectUser }),
      );

      if (!template || template.id === null) {
        return { ...review, template: null, notes: inlineNotes, active_token, chain_step_number, chain_total_steps };
      }

      // P8: snapshot wins; live template is the fallback for legacy rows.
      const enrichedFields = normalizeTemplateFields(review.template_fields ?? template.fields);

      return {
        ...review,
        template: {
          id: template.id,
          slug: template.slug,
          name: template.name,
          fields: enrichedFields,
          // §11.2 canonical wire format — see list() above for rationale.
          actions: normalizeTemplateActions(template.actions),
          auto_approve: template.auto_approve,
          instructions: template.instructions,
          allow_request_changes: template.allow_request_changes,
          allow_notes: template.allow_notes,
          allow_monitoring: template.allow_monitoring,
          enable_review_links: template.enable_review_links,
        },
        notes: inlineNotes,
        active_token,
        chain_step_number,
        chain_total_steps,
      };
    },

    async deleteReview(projectId: string, id: string) {
      // Pre-check existence + project scope so we can preserve the
      // NotFoundError contract while routing the actual delete through
      // deleteWithNoteAttachments (cascades note_attachments rows in a
      // single tx — spec §6.6 / AC #14). Also fetches status so the
      // monitoring guard fires here (single query, avoids route-layer select).
      const [existing] = await db
        .select({ id: reviews.id, status: reviews.status })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId)))
        .limit(1);
      if (!existing) throw new NotFoundError("Review not found", "review_not_found");
      // The agent that created a monitoring review must not erase the
      // oversight record mid-window (deep-review finding: DELETE was an
      // escape hatch from the veto-rate denominator). Applies to ALL actors:
      // resolve the window first, then delete.
      if (existing.status === "monitoring") {
        throw new ConflictError(
          "Resolve the monitoring window first: veto or confirm before deleting.",
          "monitoring_requires_veto_or_confirm",
        );
      }
      await deleteWithNoteAttachments(db, "review", id);
      return { id };
    },
  };
}
