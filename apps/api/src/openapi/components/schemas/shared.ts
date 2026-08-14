// Registers shared utility schemas on the central OpenAPIRegistry:
//   Error, FieldType, TemplateStatus, Scope, TemplateField, ActionConfig.
// The enum schemas (Priority, Decision, Irreversibility, ReviewStatus,
// TimeoutAction, JsonObject) are registered in ./reviews.ts. The registry
// throws on duplicate names; do not register those here.

import { z } from "zod";
import { registry } from "../../registry";

export const ErrorSchema = registry.register(
  "Error",
  z.object({
    error: z.object({
      type: z.enum([
        "invalid_request",
        "authentication_error",
        "forbidden",
        "not_found",
        "conflict",
        "gone",
        "payload_too_large",
        "rate_limited",
        "internal_error",
      ]),
      code: z.string().openapi({ example: "invalid_callback_url" }),
      message: z.string(),
      param: z.string().optional().openapi({
        description: "Which field triggered the error (when known).",
      }),
      doc_url: z.string().url(),
    }),
  }).openapi({
    description:
      "Error envelope. All 4xx/5xx responses share this shape. The nested " +
      "`error.code` is a stable machine-readable identifier; `doc_url` " +
      "links to the reference page for that code.",
  }),
);

export const FieldTypeSchema = registry.register(
  "FieldType",
  z.enum([
    "text",
    "markdown",
    "json",
    "image",
    "video",
    "number",
    "boolean",
    "select",
    "buttons",
    "date",
    "url",
  ]),
);

export const TemplateStatusSchema = registry.register(
  "TemplateStatus",
  z.enum(["draft", "active", "inactive"]),
);

export const ScopeSchema = registry.register(
  "Scope",
  z.enum([
    "reviews:create",
    "reviews:read",
    "reviews:decide",
    "templates:read",
    "templates:write",
    "feedback:read",
    "audit:read",
    "stats:read",
  ]).openapi({
    description: "Per-endpoint capability flag. Keys only see endpoints their scopes cover.",
  }),
);

export const TemplateFieldSchema = registry.register(
  "TemplateField",
  z.object({
    name: z.string(),
    label: z.string(),
    type: FieldTypeSchema,
    editable: z.boolean().optional(),
    options: z.array(z.string()).optional().openapi({
      description: "Required when `type` is `select` or `buttons`.",
    }),
  }),
);

export const ActionConfigSchema = registry.register(
  "ActionConfig",
  z.object({
    type: z.enum(["approve", "reject", "request_changes"]),
    label: z.string(),
    value: z.string(),
  }),
);
