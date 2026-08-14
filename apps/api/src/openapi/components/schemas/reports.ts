// Registers report/analytics schemas on the central OpenAPIRegistry:
//   FeedbackItem, FeedbackList, AuditEvent, AuditList, WebhookDelivery,
//   WebhookDeliveryList, Stats.
//
// References DecisionSchema and JsonObjectSchema from ./reviews; the
// side-effect import order in apps/api/src/openapi/index.ts ensures
// upstream registrations fire first.

import { z } from "zod";
import { registry } from "../../registry";
import { DecisionSchema, JsonObjectSchema } from "./reviews";
import { constLiteral } from "./_helpers";

export const FeedbackItemSchema = registry.register(
  "FeedbackItem",
  z.object({
    object: z.literal("feedback").openapi(constLiteral("feedback")),
    review_id: z.string(),
    template: z.string(),
    decision: DecisionSchema,
    original_payload: JsonObjectSchema,
    suggested_value: JsonObjectSchema.optional(),
    approved_value: JsonObjectSchema.optional(),
    edited_payload: JsonObjectSchema.optional(),
    was_edited: z.boolean().optional(),
    feedback: z.string().optional(),
    decided_at: z.string().datetime(),
  }),
);

export const FeedbackListSchema = registry.register(
  "FeedbackList",
  z.object({
    object: z.literal("list").openapi(constLiteral("list")),
    items: z.array(FeedbackItemSchema),
    has_more: z.boolean(),
    total: z.number().int().min(0).optional(),
  }),
);

export const AuditEventSchema = registry.register(
  "AuditEvent",
  z.object({
    object: z.literal("audit_event").openapi(constLiteral("audit_event")),
    id: z.string(),
    action: z.string().openapi({ example: "review.decided" }),
    actor: z.string().openapi({ example: "reviewer:alice@example.com" }),
    resource_type: z.string().nullable().optional(),
    resource_id: z.string().nullable().optional(),
    details: JsonObjectSchema.optional(),
    created_at: z.string().datetime(),
  }),
);

export const AuditListSchema = registry.register(
  "AuditList",
  z.object({
    object: z.literal("list").openapi(constLiteral("list")),
    items: z.array(AuditEventSchema),
    has_more: z.boolean(),
    total: z.number().int().min(0).optional(),
  }),
);

export const WebhookDeliverySchema = registry.register(
  "WebhookDelivery",
  z.object({
    object: z.literal("webhook_delivery").openapi(constLiteral("webhook_delivery")),
    id: z.string(),
    review_id: z.string(),
    event_type: z.string().openapi({
      description: "Matches the `X-Webhook-Event` header.",
      example: "review.decided",
    }),
    url: z.string().url(),
    status: z.enum(["pending", "delivered", "failed"]),
    attempts: z.number().int().min(0),
    max_attempts: z.number().int().min(1),
    last_attempt_at: z.string().datetime().nullable().optional(),
    next_attempt_at: z.string().datetime().nullable().optional(),
    last_error: z.string().nullable().optional(),
    delivered_at: z.string().datetime().nullable().optional(),
    created_at: z.string().datetime(),
  }),
);

export const WebhookDeliveryListSchema = registry.register(
  "WebhookDeliveryList",
  z.object({
    object: z.literal("list").openapi(constLiteral("list")),
    items: z.array(WebhookDeliverySchema),
    has_more: z.boolean(),
    total: z.number().int().min(0).optional(),
  }),
);

export const StatsSchema = registry.register(
  "Stats",
  z.object({
    object: z.literal("stats").openapi(constLiteral("stats")),
    total: z.number().int().min(0),
    by_status: z.record(z.string(), z.number().int().min(0)).openapi({
      description: "Count per ReviewStatus.",
    }),
    by_decision: z.record(z.string(), z.number().int().min(0)).openapi({
      description: "Count per Decision (only includes decided reviews).",
    }),
    avg_review_time_ms: z.number().int().nullable().optional(),
    by_template: z.array(z.object({
      template_slug: z.string(),
      count: z.number().int().min(0),
    })),
    reviews_per_day: z.array(z.object({
      date: z.string().openapi({ format: "date" }),
      count: z.number().int().min(0),
    })).openapi({
      description: "Last 30 days, ISO date → count.",
    }),
  }),
);
