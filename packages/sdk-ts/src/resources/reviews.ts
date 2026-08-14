import type { Result } from "../errors.js";
import { retryingRequest } from "../http.js";
import type { ReviewActionBody } from "@gatewerk/shared";

// Industry-standard SDK deprecation pattern: emit runtime warning exactly
// once per method per process, in addition to @deprecated JSDoc which IDEs
// surface at edit time. Mirrors Stripe/OpenAI/Twilio Node SDKs.
const __deprecationWarned = new Set<string>();
function warnDeprecated(method: string, successor: string, sunset: string): void {
  if (__deprecationWarned.has(method)) return;
  __deprecationWarned.add(method);
  // eslint-disable-next-line no-console
  console.warn(
    `[gatewerk] reviews.${method}() is deprecated for session-authenticated callers; ` +
    `use reviews.${successor}() instead. API-key (agent) callers should continue ` +
    `using reviews.${method}() until the action endpoint supports api-key auth. ` +
    `Removed in v2.0 (Sunset: ${sunset}). ` +
    `See https://docs.gatewerk.com/migration/configurable-actions for migration.`,
  );
}
const LEGACY_SUNSET = "2026-12-01";

export interface CreateReviewInput {
  template: string;
  payload: Record<string, unknown>;
  callback_url?: string;
  priority?: string;
  actions?: string[];
  confidence?: number;
  irreversibility?: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
  timeout?: { action: string; seconds: number };
  idempotency_key?: string;
}

export interface DecideInput {
  decision: string;
  feedback?: string;
  edited_payload?: Record<string, unknown>;
  reviewer?: string;
  prompt_edit?: string;
  // Wave 2: surface every field the backend's ReviewDecideBodySchema accepts
  // (apps/api/src/routes/reviews/decide.ts → ReviewDecideBodySchema). `version`
  // is the optimistic-concurrency guard for edited_payload submissions;
  // `action_value` + `action_label` carry the chosen action when the template
  // exposes a non-default action set (M11).
  version?: number;
  action_value?: string;
  action_label?: string;
}

export type ActionInput = ReviewActionBody;

export interface ListFilters {
  status?: string;
  priority?: string;
  template?: string;
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface UpdateVersionInput {
  payload: Record<string, unknown>;
  version: number;
}

export interface ReviewTemplateField {
  name: string;
  label: string;
  type: string;
  editable: boolean;
  options?: string[];
}

export interface ReviewTemplate {
  name: string;
  fields: ReviewTemplateField[];
  actions: string[];
}

export interface ReviewDetail {
  id: string;
  object: string;
  project_id: string;
  template_id: string;
  template_slug: string;
  payload: Record<string, unknown>;
  status: string;
  priority: string;
  actions: string[];
  decision?: string;
  feedback?: string;
  edited_payload?: Record<string, unknown>;
  decided_by?: string;
  decided_at?: string;
  /** Monotonically increasing revision counter. Starts at 1. */
  current_version?: number;
  /**
   * Number of revision rounds this review has gone through.
   * Derived: current_version - 1. Always present on read/mutation responses.
   * Agents use this to track how many retries occurred before a decision.
   */
  iteration_count?: number;
  created_at: string;
  updated_at: string;
  template?: ReviewTemplate;
}

export interface ReviewListResult {
  items: ReviewDetail[];
  total: number;
  has_more: boolean;
}

export interface ReviewVersion {
  id: string;
  review_id: string;
  version: number;
  payload: Record<string, unknown>;
  edited_by: string | null;
  created_at: string;
}

export interface ReviewVersionsResult {
  items: ReviewVersion[];
}

export interface ReviewToken {
  token: string;
  url: string;
  expires_at: string;
}


export class ReviewsResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  // Retry helper centralised in ../http.ts. Handles
  // {429, 500, 502, 503, 504} + network errors with exponential backoff,
  // honors Retry-After on 429. Mirrors sdk-py BaseResource._request.
  private async request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
    return retryingRequest<T>(url, init, this.headers);
  }

  async create(input: CreateReviewInput): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/reviews`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async get(id: string): Promise<Result<ReviewDetail>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}`, { method: "GET" });
  }

  async list(filters?: ListFilters): Promise<Result<ReviewListResult>> {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.template) params.set("template", filters.template);
    if (filters?.assignee) params.set("assignee", filters.assignee);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));

    const qs = params.toString();
    return this.request(`${this.baseUrl}/api/v1/reviews${qs ? `?${qs}` : ""}`, { method: "GET" });
  }

  /** @deprecated Use reviews.action(id, { action_id: "approve" | "reject", ... }) instead. Removed in v2.0 (Sunset: 2026-12-01). */
  async decide(id: string, input: DecideInput): Promise<Result<Record<string, unknown>>> {
    warnDeprecated("decide", "action", LEGACY_SUNSET);
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/decide`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Invoke a configurable action on a review.
   *
   * Requires session authentication today. API-key (agent) callers should
   * continue using decide() / retry() / cancelRequest() until the action
   * endpoint supports api-key auth. POST /api/v1/reviews/:id/action.
   */
  async action(id: string, input: ActionInput): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/action`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** @deprecated Use reviews.action(id, { action_id: "request_changes", feedback, ... }) instead. Removed in v2.0 (Sunset: 2026-12-01). */
  async retry(id: string, input: { feedback?: string; prompt_edit?: string }): Promise<Result<Record<string, unknown>>> {
    warnDeprecated("retry", "action", LEGACY_SUNSET);
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/retry`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async update(id: string, input: UpdateVersionInput): Promise<Result<Record<string, unknown>>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  // Wave 2: parity with sdk-py ReviewsResource.cancel_request.
  // POST /api/v1/reviews/:id/cancel-request — reverts a `changes_requested`
  // review to `pending`. See apps/api/src/routes/reviews/decide.ts.
  /** @deprecated Use reviews.action(id, { action_id: "cancel_iteration" }) instead. Removed in v2.0 (Sunset: 2026-12-01). */
  async cancelRequest(id: string): Promise<Result<Record<string, unknown>>> {
    warnDeprecated("cancelRequest", "action", LEGACY_SUNSET);
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/cancel-request`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  // Wave 2: parity with sdk-py ReviewsResource.versions.
  // GET /api/v1/reviews/:id/versions — lists `review_versions` rows ordered
  // by version desc. See apps/api/src/routes/reviews/lifecycle.ts.
  async versions(id: string): Promise<Result<ReviewVersionsResult>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/versions`, { method: "GET" });
  }

  // Wave 2: parity with sdk-py ReviewsResource.create_token.
  // POST /api/v1/reviews/:id/token — generates a shareable review-link token.
  // Optional `expiryHours` body field overrides the default per-template expiry.
  // See apps/api/src/routes/reviews/tokens.ts → ReviewTokenBodySchema.
  async createToken(id: string, options?: { expiryHours?: number }): Promise<Result<ReviewToken>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${id}/token`, {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  }
}
