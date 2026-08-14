import { z } from "zod";
import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

// Wave 2 MCP coverage. Mirrors packages/sdk-ts/src/resources/chains.ts and
// the chain-runs REST surface mounted by apps/api/src/routes/chains.ts:
//   POST /api/v1/chain-runs          — start a chain run (templates:write)
//   GET  /api/v1/chain-runs/:id      — chain run + steps    (reviews:read)
//   GET  /api/v1/reviews/:id/chain   — chain for review     (reviews:read)
//
// The schemas here are intentionally permissive on the definition shape — the
// API's Zod schemas are the source of truth. We surface the load-bearing
// fields (mode, steps[].template, steps[].assignee) with .describe() so
// agents understand the contract, and pass-through everything via
// z.record(z.string(), z.unknown()) for forward-compat.

const assigneeSchema = z
  .union([
    z.object({
      kind: z.literal("user"),
      email: z.string().optional(),
      user_id: z.string().optional(),
    }),
    z.object({
      kind: z.literal("role"),
      role: z.enum(["admin", "reviewer"]),
    }),
    z.object({
      kind: z.literal("external_token"),
      expires_in_seconds: z.number().optional(),
      grace_period_seconds: z.number().optional(),
      note: z.string().optional(),
    }),
  ])
  .describe(
    "Who reviews this step. {kind:'user', email|user_id} | {kind:'role', role:'admin'|'reviewer'} | {kind:'external_token', ...}",
  );

const stepSchema = z.object({
  id: z.string().describe("Step identifier (unique within the chain definition)"),
  name: z.string().optional(),
  description: z.string().optional(),
  template: z.string().describe("Template slug used for this step's review"),
  assignee: assigneeSchema,
  timeout_seconds: z.number().optional(),
  priority: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // The previous description promised DAG semantics ("Step IDs that must
  // complete before this one runs"). The engine never reads this field — it
  // advances strictly by step_number + 1 (chain-engine.ts:374-383) — so that
  // was a false statement made to a model, which is worse than a false one made
  // to a human: an LLM will plan against it. Field slated for deletion across
  // all surfaces; until then the description tells the truth.
  depends_on: z.array(z.string()).optional().describe("ACCEPTED BUT NOT ENFORCED. Steps always run in step-number order; this field creates no dependency and is ignored by the engine. Do not use it to express ordering."),
  rejection_policy: z.enum(["abort", "continue", "branch"]).optional(),
  rejection_branch_to: z.number().optional(),
});

const definitionSchema = z.object({
  version: z.literal("1.0"),
  name: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["sequential", "parallel", "mixed"]).describe("Step ordering mode"),
  rejection_policy: z.enum(["terminate", "back_one", "restart"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(stepSchema).describe("Ordered list of chain steps"),
});

export function chainTools(client: GatewerkClient): ToolDefinition[] {
  return [
    {
      name: "gatewerk_start_chain_run",
      description:
        "Start a chain run from a definition + initial payload. Returns the chain run object including the first step's review_id (step_1_review_id) so agents can pass it to reviewers.",
      scope: "templates:write",
      schema: {
        definition: definitionSchema.describe("Chain definition (version 1.0)"),
        initial_payload: z
          .record(z.string(), z.unknown())
          .describe("Payload merged into the first step's review"),
        callback_url: z.url().optional().describe("Optional webhook URL for chain events"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata for agent context"),
      },
      handler: async (params) => {
        const { data, error } = await client.chains.create({
          definition: params.definition,
          initial_payload: params.initial_payload,
          callback_url: params.callback_url,
          metadata: params.metadata,
        });
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_get_chain_run",
      description:
        "Fetch a chain run by ID. Returns the run's status, mode, rejection_policy, and the full steps[] array (each with review_id, status, and dependency wiring).",
      scope: "reviews:read",
      schema: {
        chain_run_id: z.string().describe("Chain run ID (gw_chain_...)"),
      },
      handler: async (params) => {
        const { data, error } = await client.chains.get(params.chain_run_id);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_get_chain_for_review",
      description:
        "Get chain context for a review. Returns the parent chain run plus current_step_number — useful to discover whether a review is part of a chain and what step it represents. Returns 404 if the review is not part of a chain.",
      scope: "reviews:read",
      schema: {
        review_id: z.string().describe("Review ID (gw_rev_...)"),
      },
      handler: async (params) => {
        const { data, error } = await client.chains.getForReview(params.review_id);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
  ];
}
