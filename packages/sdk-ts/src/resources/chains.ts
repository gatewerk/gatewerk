import type { Result } from "../errors.js";
import { retryingRequest } from "../http.js";

// Wave 2 (Phase A coverage). Mirrors the chain-runs REST surface mounted by
// apps/api/src/routes/chains.ts:
//   POST /api/v1/chain-runs          — create + start a chain run
//   GET  /api/v1/chain-runs/:id      — chain run + steps
//   GET  /api/v1/reviews/:id/chain   — chain context for a review
//
// The shapes here re-state @gatewerk/shared's ChainDefinition / ChainRun /
// ChainStep types. We cannot import @gatewerk/shared from the SDK because the
// SDK ships standalone to npm and the consumer must not be forced to install
// the workspace `shared` package. The shapes are kept structurally compatible
// — see packages/shared/src/api/schemas/chains.ts for the source-of-truth
// Zod schemas (ChainDefinitionSchema, ChainRunObjectSchema, ChainStepObject-
// Schema). Any drift here is a typing-quality bug; the wire format is what
// the backend Zod schema emits.

export interface ChainAssigneeUser {
  kind: "user";
  email?: string;
  user_id?: string;
}

export interface ChainAssigneeRole {
  kind: "role";
  role: "admin" | "reviewer";
}

export interface ChainAssigneeExternalToken {
  kind: "external_token";
  expires_in_seconds?: number;
  grace_period_seconds?: number;
  note?: string;
}

export type ChainAssigneeSpec =
  | ChainAssigneeUser
  | ChainAssigneeRole
  | ChainAssigneeExternalToken;

export type ChainStepRejectionPolicy = "abort" | "continue" | "branch";

export interface ChainDefinitionStep {
  id: string;
  name?: string;
  description?: string;
  template: string;
  assignee: ChainAssigneeSpec;
  timeout_seconds?: number;
  priority?: string;
  metadata?: Record<string, unknown>;
  depends_on?: string[];
  rejection_policy?: ChainStepRejectionPolicy;
  rejection_branch_to?: number;
}

export type ChainRejectionPolicy = "terminate" | "back_one" | "restart";
export type ChainMode = "sequential" | "parallel" | "mixed";

export interface ChainDefinition {
  version: "1.0";
  name?: string;
  description?: string;
  mode: ChainMode;
  rejection_policy?: ChainRejectionPolicy;
  metadata?: Record<string, unknown>;
  steps: ChainDefinitionStep[];
}

export interface ChainCreateInput {
  definition: ChainDefinition;
  initial_payload: Record<string, unknown>;
  callback_url?: string;
  metadata?: Record<string, unknown>;
}

export type ChainStepStatus =
  | "pending"
  | "active"
  | "approved"
  | "rejected"
  | "expired"
  | "skipped"
  | "superseded";

export interface ChainStepObject {
  object?: "chain_step";
  id: string;
  chain_run_id: string;
  step_number: number;
  review_id: string | null;
  assignee_spec: Record<string, unknown>;
  depends_on: string[] | null;
  status: ChainStepStatus;
  materialized_at: string | null;
  rejection_policy?: ChainStepRejectionPolicy | null;
  rejection_branch_to?: number | null;
}

export type ChainRunStatus = "active" | "completed" | "rejected" | "aborted";

export interface ChainRunObject {
  object?: "chain_run";
  id: string;
  project_id: string;
  template_id: string | null;
  name: string | null;
  mode: string;
  rejection_policy: string;
  status: ChainRunStatus;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  steps?: ChainStepObject[];
  // Only present on POST response — convenience pointer to the first step's
  // review id so callers don't have to scan steps[] (matches routes/chains.ts).
  step_1_review_id?: string;
  // Only present on GET /reviews/:id/chain — the caller's step pointer.
  current_step_number?: number | null;
}

// All three endpoints return the chain object wrapped in the standard
// envelope `{ object: "chain_run", ...fields }` (apps/api/src/routes/chains.ts
// uses envelope("chain_run", …)). Callers receive the wrapped shape directly.
export class ChainsResource {
  constructor(
    private baseUrl: string,
    private headers: () => Record<string, string>,
  ) {}

  // Retry helper centralised in ../http.ts.
  private async request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
    return retryingRequest<T>(url, init, this.headers);
  }

  async create(input: ChainCreateInput): Promise<Result<ChainRunObject>> {
    return this.request(`${this.baseUrl}/api/v1/chain-runs`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async get(runId: string): Promise<Result<ChainRunObject>> {
    return this.request(`${this.baseUrl}/api/v1/chain-runs/${runId}`, { method: "GET" });
  }

  async getForReview(reviewId: string): Promise<Result<ChainRunObject>> {
    return this.request(`${this.baseUrl}/api/v1/reviews/${reviewId}/chain`, { method: "GET" });
  }
}
