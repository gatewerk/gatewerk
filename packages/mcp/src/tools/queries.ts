import { z } from "zod";
import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

export function queryTools(client: GatewerkClient): ToolDefinition[] {
  return [
    {
      name: "gatewerk_query_feedback",
      description: "Query past review decisions for learning. Returns decided reviews with original payload, edits, and feedback.",
      scope: "feedback:read",
      schema: {
        template: z.string().optional().describe("Filter by template slug"),
        outcome: z.string().optional().describe("Filter by decision (approved, rejected, edited)"),
        limit: z.number().optional().describe("Max results (default 10)"),
        offset: z.number().optional().describe("Pagination offset"),
      },
      handler: async (params) => {
        const { data, error } = await client.feedback.query(params);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_query_audit",
      description: "Query the audit trail. Returns timestamped log of all actions (reviews created, decisions made, templates changed).",
      scope: "audit:read",
      schema: {
        action: z.string().optional().describe("Filter by action (e.g., 'review.created', 'review.decided')"),
        resource_type: z
          .string()
          .optional()
          .describe("Filter by resource type (e.g., 'review', 'template', 'note', 'chain_run')"),
        resource_id: z.string().optional().describe("Filter by specific resource ID"),
        actor: z
          .string()
          .optional()
          .describe("Filter by actor — reviewer email, or 'api_key:<id>' identifier"),
        from: z.string().optional().describe("Start date (ISO 8601)"),
        to: z.string().optional().describe("End date (ISO 8601)"),
        limit: z.number().optional().describe("Max results (default 20)"),
        offset: z.number().optional().describe("Pagination offset"),
      },
      handler: async (params) => {
        const { data, error } = await client.audit.query(params);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
  ];
}
