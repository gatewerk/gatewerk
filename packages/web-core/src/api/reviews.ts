import { z } from "zod";
import {
  ReviewObjectSchema,
  ReviewListResponseSchema,
  ReviewCreateBodySchema,
  ReviewDecideBodySchema,
  ReviewRetryBodySchema,
  ReviewActionBodySchema,
  ReviewUpdateVersionBodySchema,
  ReviewBulkIdsBodySchema,
  ReviewNoteBodySchema,
  ReviewListQuerySchema,
  type ReviewListQuery,
  type ReviewCreateBody,
  type ReviewDecideBody,
  type ReviewRetryBody,
  type ReviewActionBody,
  type ReviewUpdateVersionBody,
  type ListReviewTokensResponse,
  type ExpiredTokenSummaryResponse,
  type ChainStepTokenStatus,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";
import { request } from "./client/http";

export type Review = z.infer<typeof ReviewObjectSchema>;
export type ReviewListPage = z.infer<typeof ReviewListResponseSchema>;

const NoteSchema = z.object({
  id: z.string(),
  content: z.string(),
  author: z.string(),
  created_at: z.string(),
});
const NoteListSchema = z.object({ items: z.array(NoteSchema) });
const OkSchema = z.object({ ok: z.boolean() });
// archived_ids / deleted_ids are optional for old-server compat: servers
// predating the monitoring-guards release return only { ok, count }. Undo
// falls back to the full selection when absent.
const BulkResultSchema = z.object({
  ok: z.boolean(),
  count: z.number(),
  archived_ids: z.array(z.string()).optional(),
  deleted_ids: z.array(z.string()).optional(),
});

export type Note = z.infer<typeof NoteSchema>;
type NoteList = z.infer<typeof NoteListSchema>;

export interface VersionRow {
  id: string;
  review_id: string;
  version: number;
  payload: Record<string, unknown>;
  feedback: string | null;
  created_at: string;
}

export const listReviews = defineQuery<ReviewListQuery, ReviewListPage>({
  path: "/api/v1/reviews",
  queryKey: (input: ReviewListQuery) => ["reviews", "list", input] as const,
  responseSchema: ReviewListResponseSchema,
  search: (input: ReviewListQuery) => ({
    status: input.status,
    priority: input.priority,
    template: input.template,
    assignee: input.assignee,
    limit: input.limit,
    offset: input.offset,
  }),
});

export const getReview = defineQuery<{ id: string }, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}`,
  queryKey: ({ id }: { id: string }) => ["reviews", "detail", id] as const,
  responseSchema: ReviewObjectSchema,
});

export const listReviewNotes = defineQuery<{ id: string }, NoteList>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/notes`,
  queryKey: ({ id }: { id: string }) => ["reviews", id, "notes"] as const,
  responseSchema: NoteListSchema,
});

export const createReview = defineMutation<ReviewCreateBody, Review>({
  path: "/api/v1/reviews",
  method: "POST",
  bodySchema: ReviewCreateBodySchema,
  responseSchema: ReviewObjectSchema,
});

export const decideReviewMutation = defineMutation<{ id: string } & ReviewDecideBody, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/decide`,
  method: "POST",
  responseSchema: ReviewObjectSchema,
});

// Configurable-actions Phase 5 (spec §3.1 + §14 Phase 5). Unified body
// shape for every action invocation — decision, iteration, side_effect
// kinds — replacing the per-endpoint /decide /retry /cancel-request
// shapes during the v1.4 → v1.5 transition. The legacy mutations stay
// exported so SDK consumers (sdk-ts, sdk-py, n8n, MCP) and the bulk pane
// keep working; Phase 6 migrates them.
export const actionReviewMutation = defineMutation<
  { id: string } & ReviewActionBody,
  Review
>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/action`,
  method: "POST",
  // bodySchema is intentionally omitted: defineMutation's safeParse runs
  // against the WHOLE input including the path-shaped { id, ... }, but
  // ReviewActionBodySchema covers only the on-wire body fields. Adding
  // it would reject every call. Matches the decideReviewMutation pattern
  // where the body schema is also intentionally absent — server-side
  // ReviewActionBodySchema validation is the source of truth.
  responseSchema: ReviewObjectSchema,
});

// HOTL monitoring gate (spec §4.9). veto: POST /reviews/:id/veto with
// optional note in the body. confirm: POST /reviews/:id/confirm, no body.
// defineMutation serializes the full input object as the JSON body, so veto
// body includes { id, note? }. Zod 4 strips unknown keys server-side, so
// the id in the body is harmless — matches the actionReviewMutation pattern
// which also passes { id, ...body } through unchanged.
export const vetoReviewMutation = defineMutation<
  { id: string; note?: string },
  Review
>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/veto`,
  method: "POST",
  responseSchema: ReviewObjectSchema,
});

export const confirmReviewMutation = defineMutation<
  { id: string },
  Review
>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/confirm`,
  method: "POST",
  bodyless: true,
  responseSchema: ReviewObjectSchema,
});

export const retryReviewMutation = defineMutation<{ id: string } & ReviewRetryBody, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/retry`,
  method: "POST",
  responseSchema: ReviewObjectSchema,
});

export const updateReviewVersion = defineMutation<{ id: string } & ReviewUpdateVersionBody, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}`,
  method: "PUT",
  responseSchema: ReviewObjectSchema,
});

export const archiveReview = defineMutation<{ id: string }, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/archive`,
  method: "POST",
  bodyless: true,
  responseSchema: ReviewObjectSchema,
});

export const unarchiveReview = defineMutation<{ id: string }, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/unarchive`,
  method: "POST",
  bodyless: true,
  responseSchema: ReviewObjectSchema,
});

export const cancelReviewRequest = defineMutation<{ id: string }, Review>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/cancel-request`,
  method: "POST",
  bodyless: true,
  responseSchema: ReviewObjectSchema,
});

export const deleteReviewMutation = defineMutation<{ id: string }, { ok: boolean }>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
  responseSchema: OkSchema,
});

export const bulkArchiveReviews = defineMutation<{ ids: string[] }, { ok: boolean; count: number; archived_ids?: string[] }>({
  path: "/api/v1/reviews/bulk/archive",
  method: "POST",
  bodySchema: ReviewBulkIdsBodySchema,
  responseSchema: BulkResultSchema,
});

export const bulkDeleteReviews = defineMutation<{ ids: string[] }, { ok: boolean; count: number; deleted_ids?: string[] }>({
  path: "/api/v1/reviews/bulk/delete",
  method: "POST",
  bodySchema: ReviewBulkIdsBodySchema,
  responseSchema: BulkResultSchema,
});

export const createReviewNote = defineMutation<{ id: string; content: string }, Note>({
  path: ({ id }: { id: string }) => `/api/v1/reviews/${encodeURIComponent(id)}/notes`,
  method: "POST",
  bodySchema: z.object({ id: z.string(), content: z.string().min(1) }),
  responseSchema: NoteSchema,
});

// Chain stepper types — returned by GET /api/v1/reviews/:id/chain.
// The API envelope() spreads into the top-level object, so `object` is also
// present in the raw response alongside these fields.
export interface ChainStep {
  id: string;
  chain_run_id: string;
  step_number: number;
  name?: string | null;
  review_id: string | null;
  assignee_spec: unknown;
  depends_on: unknown;
  status: string; // "pending" | "active" | "completed" | "skipped" | "failed"
  materialized_at: string | null;
  rejection_policy: string | null;
  rejection_branch_to: number | null;
  token_status: ChainStepTokenStatus | null;
  /**
   * C1 relay: this step's own decision, present only once the step's review
   * reached a terminal state. The chain stepper renders these as the prior
   * judgments a later reviewer needs in order to do their part.
   */
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  feedback: string | null;
  /** One line telling this step's reviewer what to weigh. */
  guidance: string | null;
}

export interface ChainContext {
  id: string;
  project_id: string;
  template_id: string | null;
  name: string | null;
  mode: string;
  rejection_policy: string;
  status: string; // "active" | "completed" | "failed"
  metadata: unknown;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  steps: ChainStep[];
  current_step_number: number | null;
}

// Review draft endpoints — id-in-path / payload-in-body. Following the templates.ts
// `sendDraftUpdate` precedent (request directly) so the body shape is `{ draft_payload }`,
// not `{ id, draft_payload }`. Auth header handled by http.ts via getToken().
async function setReviewDraft(id: string, draft_payload: Record<string, unknown>): Promise<void> {
  await request<unknown>(`/api/v1/reviews/${encodeURIComponent(id)}/draft`, {
    method: "PUT",
    body: JSON.stringify({ draft_payload }),
  });
}

async function discardReviewDraft(id: string): Promise<void> {
  await request<unknown>(`/api/v1/reviews/${encodeURIComponent(id)}/draft`, {
    method: "DELETE",
  });
}

export const reviews = {
  list: (filters: ReviewListQuery = {}) => listReviews.run(filters),
  get: (id: string) => getReview.run({ id }),
  decide: (
    id: string,
    data: { decision: string; feedback?: string; edited_payload?: Record<string, unknown>; version?: number },
  ) => decideReviewMutation({ id, ...(data as ReviewDecideBody) }),
  retry: (id: string, data: { feedback: string; prompt_edit?: string }) =>
    retryReviewMutation({ id, ...data }),
  cancelRequest: (id: string) => cancelReviewRequest({ id }),
  // Configurable-actions Phase 5: unified action invocation. Used by
  // ActionRow + ActionFeedbackComposer in the inbox right pane.
  action: (
    id: string,
    data: {
      action_id: string;
      feedback?: string;
      edited_payload?: Record<string, unknown>;
      version?: number;
    },
  ) => actionReviewMutation({ id, ...data }),
  // HOTL monitoring gate mutations (spec §4.9).
  veto: (id: string, note?: string) => vetoReviewMutation({ id, ...(note !== undefined ? { note } : {}) }),
  confirm: (id: string) => confirmReviewMutation({ id }),
  createNote: (id: string, content: string) => createReviewNote({ id, content }),
  listNotes: (id: string) => listReviewNotes.run({ id }),
  archive: (id: string) => archiveReview({ id }),
  unarchive: (id: string) => unarchiveReview({ id }),
  deleteReview: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/reviews/${encodeURIComponent(id)}`, { method: "DELETE" }),
  bulkArchive: (ids: string[]) => bulkArchiveReviews({ ids }),
  bulkDelete: (ids: string[]) => bulkDeleteReviews({ ids }),
  setDraft: (id: string, draft_payload: Record<string, unknown>) => setReviewDraft(id, draft_payload),
  discardDraft: (id: string) => discardReviewDraft(id),
  // Body shape mirrors ReviewTokenBodySchema in
  // apps/api/src/routes/reviews/tokens.ts. All three auth tiers are live.
  // The cross-field contract is enforced server-side: "email_otp" requires
  // auth_email, "account" requires auth_user_id, and "public" permits
  // neither — violations come back 422 with a field-level code.
  createReviewToken: (
    reviewId: string,
    body: {
      purpose?: string;
      recipient_label: string;
      note?: string;
      auth_level?: "public" | "email_otp" | "account";
      auth_email?: string;
      auth_user_id?: string;
      expiryHours?: number;
      preview?: boolean;
    },
  ) => request<{ token: string; review_id: string; expires_at: string; url: string }>(
    `/api/v1/reviews/${encodeURIComponent(reviewId)}/token`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  revokeReviewToken: (
    reviewId: string,
    body: { reason?: string } = {},
  ) => request<{ success: true }>(
    `/api/v1/reviews/${encodeURIComponent(reviewId)}/token/revoke`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  // Share-modal manage mode: push the active token's expiry out by N hours
  // (1..720). 404s when there is no active token.
  extendReviewToken: (
    reviewId: string,
    body: { hours: number },
  ) => request<{ success: true; expires_at: string }>(
    `/api/v1/reviews/${encodeURIComponent(reviewId)}/token/extend`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  // Token-history-panel. Read-only paginated history of all tokens for a
  // review. Status field is
  // server-computed (revoked > used > expired > active). Backed by index
  // review_tokens(review_id, created_at DESC).
  listReviewTokens: (
    reviewId: string,
    opts: { limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return request<ListReviewTokensResponse>(
      `/api/v1/reviews/${encodeURIComponent(reviewId)}/tokens${qs ? `?${qs}` : ""}`,
      { method: "GET" },
    );
  },
  getExpiredTokenSummary: () =>
    request<ExpiredTokenSummaryResponse>(
      `/api/v1/reviews/expired-token-summary`,
      { method: "GET" },
    ),
  listVersions: (reviewId: string) =>
    request<{ items: VersionRow[] }>(
      `/api/v1/reviews/${encodeURIComponent(reviewId)}/versions`,
    ),
  // Chain stepper: returns chain run context including all steps and the
  // current step number. Only valid when review.chain_run_id is non-null.
  // The API's envelope() spreads fields at top level alongside `object`.
  getChainContext: (reviewId: string) =>
    request<ChainContext>(
      `/api/v1/reviews/${encodeURIComponent(reviewId)}/chain`,
    ),
  // Human workflow primitives (v1). claim: soft-lock the review to the
  // current actor; force=true force-claims when already held (requires
  // reviews:assign). release: clear held_by (only the holder or an admin).
  // assign: admin reassigns + optionally sets hold. snooze: set or clear
  // snoozed_until (null clears). Force is a query param, not a body field.
  claim: (id: string, opts?: { force?: boolean }) => {
    const qs = opts?.force ? "?force=true" : "";
    return request<Review>(`/api/v1/reviews/${encodeURIComponent(id)}/claim${qs}`, {
      method: "POST",
    });
  },
  release: (id: string) =>
    request<Review>(`/api/v1/reviews/${encodeURIComponent(id)}/release`, {
      method: "POST",
    }),
  assign: (id: string, body: { assignee: string; hold?: boolean }) =>
    request<Review>(`/api/v1/reviews/${encodeURIComponent(id)}/assign`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  snooze: (id: string, body: { until: string | null }) =>
    request<Review>(`/api/v1/reviews/${encodeURIComponent(id)}/snooze`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
