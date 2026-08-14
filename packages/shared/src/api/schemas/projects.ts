import { z } from "zod";

const IsoDateString = z.string();

const ApiKeySummarySchema = z.object({
  id: z.string(),
  key_prefix: z.string(),
  is_active: z.boolean(),
});

export const ProjectSettingsObjectSchema = z.object({
  object: z.literal("project").optional(),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  webhook_url: z.string().nullable(),
  api_keys: z.array(ApiKeySummarySchema).optional(),
  created_at: IsoDateString,
  updated_at: IsoDateString,
});

export const ProjectUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  webhook_url: z.url().nullable().optional(),
});

// GET /api/v1/settings/hmac-secret response — metadata only (prefix +
// has_secret). The full secret is returned exclusively by the `reveal` and
// `rotate` endpoints, each of which emits an audit log entry on every call.
// This shape was tightened to close a finding: the HMAC secret was
// exposed on every admin page load.
export const HmacSecretPreviewResponseSchema = z.object({
  prefix: z.string(),
  has_secret: z.boolean(),
});

// Response shape for POST /api/v1/settings/hmac-secret/reveal and
// POST /api/v1/settings/hmac-secret/rotate — both return the full secret
// exactly once and audit-log the caller.
export const HmacSecretResponseSchema = z.object({
  hmac_secret: z.string(),
});

// Kept as an alias for backward compatibility with the pre-redesign wire contract.
// All callers of GET /hmac-secret should migrate to HmacSecretPreviewResponse.
export const HmacSecretRotateResponseSchema = HmacSecretResponseSchema;

export type ProjectSettingsObject = z.infer<typeof ProjectSettingsObjectSchema>;
export type ProjectUpdateBody = z.infer<typeof ProjectUpdateBodySchema>;
export type HmacSecretPreviewResponse = z.infer<typeof HmacSecretPreviewResponseSchema>;
export type HmacSecretResponse = z.infer<typeof HmacSecretResponseSchema>;
export type HmacSecretRotateResponse = z.infer<typeof HmacSecretRotateResponseSchema>;
