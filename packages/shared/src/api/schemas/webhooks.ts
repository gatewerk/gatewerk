import { z } from "zod";

const IsoDateString = z.string();

export const NOTIFICATION_CHANNEL_TYPES = ["generic", "slack", "discord", "telegram"] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];
export const NotificationChannelTypeSchema = z.enum(NOTIFICATION_CHANNEL_TYPES);

export const WebhookObjectSchema = z.object({
  object: z.literal("webhook").optional(),
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  webhook_url: z.string(),
  events: z.array(z.string()),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  is_active: z.boolean(),
  type: NotificationChannelTypeSchema,
  created_at: IsoDateString,
  // Outcome of the most recent real (non-test) delivery attempt, written by
  // NotificationService — null/null/null until the channel has fired once.
  last_delivery_at: IsoDateString.nullable().optional(),
  last_delivery_status: z.enum(["success", "failed"]).nullable().optional(),
  last_error: z.string().nullable().optional(),
});

export const WebhookListResponseSchema = z.object({
  object: z.literal("list"),
  items: z.array(WebhookObjectSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
});

export const WebhookCreateBodySchema = z.object({
  name: z.string().min(1),
  webhook_url: z.url(),
  events: z.array(z.string().min(1)).min(1, "events must be a non-empty array"),
  headers: z.record(z.string(), z.string()).optional(),
  type: NotificationChannelTypeSchema.optional().default("generic"),
});

export const WebhookUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  webhook_url: z.url().optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  is_active: z.boolean().optional(),
  type: NotificationChannelTypeSchema.optional(),
});

export type WebhookObject = z.infer<typeof WebhookObjectSchema>;
export type WebhookListResponse = z.infer<typeof WebhookListResponseSchema>;
export type WebhookCreateBody = z.infer<typeof WebhookCreateBodySchema>;
export type WebhookUpdateBody = z.infer<typeof WebhookUpdateBodySchema>;

// Pre-default INPUT shape — what the caller may send over the wire.
// `type` is optional (server defaults to "generic" via zod schema). Use this
// when typing client-side mutation inputs that need bodySchema validation;
// `z.infer` gives the OUTPUT shape where `type` is required, which would
// force callers to pass it even though omission is valid.
// Pattern: api-keys.ts (z.input vs z.infer for fields with default()).
export type WebhookCreateBodyInput = z.input<typeof WebhookCreateBodySchema>;

export const WebhookTestBodySchema = z.object({
  webhook_url: z.url(),
  type: NotificationChannelTypeSchema.optional().default("generic"),
  headers: z.record(z.string(), z.string()).optional(),
});

export const WebhookTestResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().int(),
  status_text: z.string(),
  response_preview: z.string(),
  latency_ms: z.number().int().nonnegative(),
});

export type WebhookTestBody = z.infer<typeof WebhookTestBodySchema>;
export type WebhookTestBodyInput = z.input<typeof WebhookTestBodySchema>;
export type WebhookTestResponse = z.infer<typeof WebhookTestResponseSchema>;
