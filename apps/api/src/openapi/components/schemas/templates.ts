// Registers Template-domain schemas on the central OpenAPIRegistry:
//   Template, TemplateList, TemplateCreateBody, TemplateUpdateBody.
//
// Cross-file imports: PrioritySchema + TimeoutActionSchema from ./reviews,
// TemplateStatusSchema + TemplateFieldSchema + ActionConfigSchema from
// ./shared. Side-effect imports in apps/api/src/openapi/index.ts ensure
// the upstream registrations fire first.

import { z } from "zod";
import { registry } from "../../registry";
import {
  PrioritySchema,
  TimeoutActionSchema,
} from "./reviews";
import {
  TemplateStatusSchema,
  TemplateFieldSchema,
  ActionConfigSchema,
} from "./shared";
import { constLiteral } from "./_helpers";

// Helper: actions[] item shape — either a string shorthand OR a structured ActionConfig
const TemplateActionsItem = z.union([z.string(), ActionConfigSchema]);

export const TemplateSchema = registry.register(
  "Template",
  z.object({
    object: z.literal("template").openapi(constLiteral("template")),
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    fields: z.array(TemplateFieldSchema),
    actions: z.array(TemplateActionsItem).optional().openapi({
      description: "Either legacy string shorthand (`['approve','reject']`) or structured `ActionConfig[]`.",
    }),
    default_priority: PrioritySchema.optional(),
    project_id: z.string(),
    status: TemplateStatusSchema.optional(),
    auto_approve: z.boolean().optional(),
    enable_review_links: z.boolean().optional(),
    default_auth_level: z.enum(["public", "email_otp", "account"]).optional().openapi({
      description: "Pre-fill auth tier for ShareViaLinkDialog (spec section 8.5).",
    }),
    default_expiry_seconds: z.number().int().min(1).max(2592000).optional().openapi({
      description: "Pre-fill link expiry in seconds (spec section 8.5). 86400 = 24h, 604800 = 7d, 2592000 = 30d.",
    }),
    timeout_seconds: z.number().int().nullable().optional(),
    timeout_action: z.union([TimeoutActionSchema, z.null()]).optional(),
    instructions: z.string().nullable().optional(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  }),
);

export const TemplateListSchema = registry.register(
  "TemplateList",
  z.object({
    object: z.literal("list").openapi(constLiteral("list")),
    items: z.array(TemplateSchema),
    has_more: z.boolean(),
    total: z.number().int().min(0).optional(),
  }),
);

export const TemplateCreateBodySchema = registry.register(
  "TemplateCreateBody",
  z.object({
    slug: z.string().openapi({
      description: "URL-safe identifier; referenced by `POST /reviews.template`.",
    }),
    name: z.string(),
    description: z.string().optional(),
    fields: z.array(TemplateFieldSchema).min(1),
    actions: z.array(TemplateActionsItem).optional().openapi({
      description: "Optional. Defaults to approve/reject/request_changes.",
    }),
    default_priority: PrioritySchema.optional(),
    enable_review_links: z.boolean().optional(),
    auto_approve: z.boolean().optional(),
    timeout_seconds: z.number().int().min(60).nullable().optional(),
    timeout_action: z.union([TimeoutActionSchema, z.null()]).optional(),
    instructions: z.string().optional(),
    default_auth_level: z.enum(["public", "email_otp", "account"]).optional(),
    default_expiry_seconds: z.number().int().min(1).max(2592000).optional(),
  }),
);

export const TemplateUpdateBodySchema = registry.register(
  "TemplateUpdateBody",
  z.object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    fields: z.array(TemplateFieldSchema).min(1).optional(),
    actions: z.array(TemplateActionsItem).optional(),
    default_priority: PrioritySchema.optional(),
    enable_review_links: z.boolean().optional(),
    auto_approve: z.boolean().optional(),
    timeout_seconds: z.number().int().min(60).nullable().optional(),
    timeout_action: z.union([TimeoutActionSchema, z.null()]).optional(),
    instructions: z.string().nullable().optional(),
    changes_timeout_hours: z.number().nullable().optional(),
    default_auth_level: z.enum(["public", "email_otp", "account"]).optional(),
    default_expiry_seconds: z.number().int().min(1).max(2592000).optional(),
  }).openapi({
    description: "All fields optional — pass only what you want to change.",
  }),
);
