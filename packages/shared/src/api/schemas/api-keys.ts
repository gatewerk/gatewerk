import { z } from "zod";
import { SCOPES } from "../../enums";

const IsoDateString = z.string();

const ScopeSchema = z.enum(SCOPES);

export const ApiKeyObjectSchema = z.object({
  object: z.literal("api_key").optional(),
  id: z.string(),
  project_id: z.string().optional(),
  name: z.string().nullable(),
  label: z.string().nullable().optional(),
  description: z.string().nullable(),
  key_prefix: z.string(),
  scopes: z.array(ScopeSchema).nullable(),
  template_ids: z.array(z.string()).nullable(),
  callback_url: z.string().nullable(),
  default_reviewer: z.string().nullable(),
  rate_limit_per_hour: z.number().int().nullable(),
  is_active: z.boolean(),
  last_used_at: IsoDateString.nullable(),
  created_at: IsoDateString,
  expires_at: IsoDateString.nullable(),
  ip_allowlist: z.array(z.string()).nullable(),
});

export const ApiKeyListResponseSchema = z.object({
  object: z.literal("list"),
  items: z.array(ApiKeyObjectSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
});

export const ApiKeyWithSecretSchema = ApiKeyObjectSchema.extend({
  raw_key: z.string(),
});

// IP or CIDR (v4 or v6). Kept permissive at the zod layer — the route handler
// parses each entry with node:net to catch malformed values with a clear error.
const IpOrCidrSchema = z.string().min(1).max(64);

export const ApiKeyCreateBodySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(ScopeSchema).min(1, "scopes must be a non-empty array"),
  description: z.string().optional(),
  template_ids: z.array(z.string()).nullable().optional(),
  callback_url: z.url().optional(),
  default_reviewer: z.string().optional(),
  rate_limit_per_hour: z.number().int().positive().optional(),
  expires_at: z.iso.datetime().nullable().optional(),
  ip_allowlist: z.array(IpOrCidrSchema).nullable().optional(),
});

export const ApiKeyUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  scopes: z.array(ScopeSchema).min(1).optional(),
  template_ids: z.array(z.string()).nullable().optional(),
  callback_url: z.url().nullable().optional(),
  default_reviewer: z.string().nullable().optional(),
  rate_limit_per_hour: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
  expires_at: z.iso.datetime().nullable().optional(),
  ip_allowlist: z.array(IpOrCidrSchema).nullable().optional(),
});

// Per-key usage + metrics response (Phase 4 observability).
// Sparkline buckets are populated-only (server groups by date_trunc('hour', …));
// the UI fills the missing hours with 0 so the 24-bar rendering is stable
// even for a fresh key with zero requests.
export const ApiKeyUsageSparklineBucketSchema = z.object({
  hour: IsoDateString,
  count: z.number().int().nonnegative(),
});

export const ApiKeyUsageRecentRequestSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  status_code: z.number().int(),
  created_at: IsoDateString,
});

export const ApiKeyUsageResponseSchema = z.object({
  requests_today: z.number().int().nonnegative(),
  rate_limit_used_pct: z.number().int().nullable(),
  rate_limit_per_hour: z.number().int().nullable(),
  sparkline: z.array(ApiKeyUsageSparklineBucketSchema),
  recent_requests: z.array(ApiKeyUsageRecentRequestSchema),
});

export type ApiKeyObject = z.infer<typeof ApiKeyObjectSchema>;
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponseSchema>;
export type ApiKeyWithSecret = z.infer<typeof ApiKeyWithSecretSchema>;
export type ApiKeyCreateBody = z.infer<typeof ApiKeyCreateBodySchema>;
export type ApiKeyUpdateBody = z.infer<typeof ApiKeyUpdateBodySchema>;
export type ApiKeyUsageResponse = z.infer<typeof ApiKeyUsageResponseSchema>;
export type ApiKeyUsageSparklineBucket = z.infer<typeof ApiKeyUsageSparklineBucketSchema>;
export type ApiKeyUsageRecentRequest = z.infer<typeof ApiKeyUsageRecentRequestSchema>;
