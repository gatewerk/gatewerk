import { z } from "zod";
import type { GatewerkClient } from "gatewerk";
import type { ToolDefinition } from "../types.js";
import { toolSuccess, toolError } from "../types.js";

const fieldSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "markdown", "json", "image", "number", "boolean", "select", "buttons"]),
  label: z.string(),
  readonly: z.boolean().optional(),
  editable: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

export function templateTools(client: GatewerkClient): ToolDefinition[] {
  return [
    {
      name: "gatewerk_list_templates",
      description: "Discover available review templates. Returns all templates with their fields and actions.",
      scope: "templates:read",
      schema: {},
      handler: async () => {
        const { data, error } = await client.templates.list();
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_create_template",
      description: "Define a new review template with form fields and available actions.",
      scope: "templates:write",
      schema: {
        slug: z.string().describe("URL-safe identifier (lowercase, hyphens, e.g., 'invoice-approval')"),
        name: z.string().describe("Human-readable template name"),
        description: z.string().optional().describe("What this template is used for"),
        fields: z.array(fieldSchema).describe("Form fields for the review"),
        actions: z.array(z.string()).describe("Available actions (e.g., ['approve', 'reject', 'edit'])"),
        default_priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      },
      handler: async (params) => {
        const { data, error } = await client.templates.create(params);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_update_template",
      description: "Modify an existing template's name, fields, actions, or priority.",
      scope: "templates:write",
      schema: {
        template_id: z.string().describe("Template ID (gw_tpl_...)"),
        name: z.string().optional(),
        description: z.string().optional(),
        fields: z.array(fieldSchema).optional(),
        actions: z.array(z.string()).optional(),
        default_priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      },
      handler: async (params) => {
        const { template_id, ...updates } = params;
        const { data, error } = await client.templates.update(template_id, updates);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
    {
      name: "gatewerk_delete_template",
      description: "Remove a template. Existing reviews using this template are not affected.",
      scope: "templates:write",
      schema: {
        template_id: z.string().describe("Template ID to delete (gw_tpl_...)"),
      },
      handler: async (params) => {
        const { data, error } = await client.templates.delete(params.template_id);
        return error ? toolError(error.message) : toolSuccess(data);
      },
    },
  ];
}
