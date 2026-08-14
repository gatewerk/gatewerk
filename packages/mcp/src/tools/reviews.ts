import { z } from "zod";
import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

export function reviewTools(client: GatewerkClient, reviewer?: string): ToolDefinition[] {
  return [
    {
      name: "gatewerk_create_review",
      description: "Submit a review request for human oversight. Returns the created review with its ID and status.",
      scope: "reviews:create",
      schema: {
        template: z.string().describe("Template slug (e.g., 'email-review', 'code-deploy')"),
        payload: z.record(z.string(), z.unknown()).describe("Data fields matching the template schema. Call gatewerk_list_templates first to discover the field names and types for your chosen template."),
        callback_url: z
          .string()
          .url()
          .optional()
          .describe(
            "Webhook URL to receive the review decision. Optional — agents using MCP often don't have a webhook and can poll gatewerk_get_review or wait for tool re-invocation.",
          ),
        priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("Review priority"),
        assignee: z.string().optional().describe("Assign to specific reviewer (email)"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata for agent context"),
        timeout: z.object({
          action: z.enum(["auto_approve", "auto_reject", "expire"]),
          seconds: z.number(),
        }).optional().describe("Auto-expiry policy"),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            "Unique key scoped to the project. A second call with the same key returns the existing review instead of creating a duplicate. Useful for LangGraph node replays and agent retries.",
          ),
      },
      handler: async (params) => {
        const { data, error } = await client.reviews.create(params);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_list_reviews",
      description: "List reviews with optional filters. Returns paginated list of reviews.",
      scope: "reviews:read",
      schema: {
        status: z.enum(["pending", "decided", "expired", "monitoring"]).optional().describe("Filter by status"),
        priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("Filter by priority"),
        template: z.string().optional().describe("Filter by template slug"),
        assignee: z.string().optional().describe("Filter by assignee"),
        limit: z.number().optional().describe("Max results (default 20)"),
        offset: z.number().optional().describe("Pagination offset"),
      },
      handler: async (params) => {
        const { data, error } = await client.reviews.list(params);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_get_review",
      description: "Get full review details by ID, including payload, status, decision, feedback, and template metadata (field labels, types, editable flags, and available actions). Use this to present structured review forms in conversation.",
      scope: "reviews:read",
      schema: {
        review_id: z.string().describe("Review ID (gw_rev_...)"),
      },
      handler: async (params) => {
        const { data, error } = await client.reviews.get(params.review_id);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_decide_review",
      description: "[Deprecated; use gatewerk_take_review_action for templates with custom actions] Submit a decision on a pending review. Supports approve, reject, edit (with modified payload), or retry (request changes with feedback).",
      scope: "reviews:decide",
      schema: {
        review_id: z.string().describe("Review ID to decide on"),
        // NOTE: "vetoed" / "confirmed" are intentionally absent — monitoring
        // outcomes are human-dashboard actions, not MCP agent actions.
        decision: z.enum(["approved", "rejected", "edited", "retried"]).describe("Decision outcome"),
        feedback: z.string().optional().describe("Feedback or reason for decision"),
        edited_payload: z.record(z.string(), z.unknown()).optional().describe("Modified payload (required for 'edited' decision)"),
        reviewer: z.string().optional().describe("Reviewer identity (auto-filled from GATEWERK_REVIEWER if set)"),
        prompt_edit: z.string().optional().describe("Suggested prompt improvement for the agent"),
      },
      handler: async (params) => {
        const resolvedReviewer = params.reviewer || reviewer;

        // Route retry to the retry endpoint (separate API endpoint)
        // Note: reviewer attribution is not passed for retry — the retry API
        // endpoint does not accept a reviewer field. This is an API limitation.
        if (params.decision === "retried") {
          const { data, error } = await client.reviews.retry(params.review_id, {
            feedback: params.feedback,
            prompt_edit: params.prompt_edit,
          });
          return error ? toolError(error.message) : toolSuccess(data);
        }

        const { data, error } = await client.reviews.decide(params.review_id, {
          decision: params.decision,
          feedback: params.feedback,
          edited_payload: params.edited_payload,
          reviewer: resolvedReviewer,
          prompt_edit: params.prompt_edit,
        });
        if (error) return toolError(error.message);
        return toolSuccess({
          ...data,
          _deprecation_notice: "gatewerk_decide_review is deprecated; switch to gatewerk_take_review_action by 2026-12-01. The /action endpoint supports both session and api-key authentication.",
        });
      },
    },
    {
      name: "gatewerk_take_review_action",
      description: "Invoke a configurable action on a review. Supersedes gatewerk_decide_review for templates with custom actions. Built-in action_ids: 'approve', 'reject', 'request_changes', 'cancel_iteration'. Custom action_ids are template-specific — use gatewerk_list_review_actions to introspect available actions. Supports both session and api-key (agent) authentication.",
      scope: "reviews:decide",
      schema: {
        review_id: z.string().describe("Review ID (gw_rev_...)"),
        action_id: z.string().min(1).describe("Action identifier as configured on the template"),
        feedback: z.string().optional().describe("Required for actions with requires_feedback=true; optional otherwise"),
        edited_payload: z.record(z.string(), z.unknown()).optional().describe("Modified payload (for edit-on-approve flows)"),
        version: z.number().int().positive().optional().describe("Optimistic-concurrency guard for edited_payload submissions"),
      },
      handler: async (params) => {
        const { data, error } = await client.reviews.action(params.review_id, {
          action_id: params.action_id,
          feedback: params.feedback,
          edited_payload: params.edited_payload,
          version: params.version,
        });
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_list_review_actions",
      description: "Introspect the configurable actions available on a review's template. Returns the review's canonical TemplateActionConfig[] (action.id, label, kind, decision_value, enabled_for_status, requires_feedback, confirmation, expose_to_recipient, style, description, webhook_event). Use before gatewerk_take_review_action to choose a valid action_id.",
      scope: "reviews:read",
      schema: {
        review_id: z.string().describe("Review ID (gw_rev_...)"),
      },
      handler: async (params) => {
        const { data, error } = await client.reviews.get(params.review_id);
        if (error) return toolError(error.message);
        const template = (data as { template?: unknown })?.template;
        if (template == null) {
          return toolError("Review has no template associated; cannot list actions.");
        }
        const actions = (template as { actions?: unknown }).actions ?? [];
        return toolSuccess({ review_id: params.review_id, actions });
      },
    },
  ];
}
