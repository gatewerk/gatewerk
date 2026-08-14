/**
 * Pure form logic for the API keys pane. Ported from
 * apps/web/src/pages/settings/project/api-keys/_forms.ts rather than imported:
 * apps/web is frozen and every import into it is one more module the eventual
 * deletion has to unpick.
 */
import { SCOPE_PRESETS, type Scope } from "@gatewerk/shared";
import type { ApiKey, ApiKeyWithSecret } from "@gatewerk/web-core/api/api-keys";
import type { ApiKeyCreateBody, ApiKeyUpdateBody } from "@gatewerk/shared";

export type ScopePreset = "agent" | "reviewer" | "admin" | "custom";

export type ExpirationPreset = "never" | "30d" | "60d" | "90d" | "custom";

export const PRESET_LABELS: Record<ScopePreset, string> = {
  agent: "Agent",
  reviewer: "Reviewer",
  admin: "Admin",
  custom: "Custom",
};

export const EXPIRATION_OPTIONS: { value: ExpirationPreset; label: string; days?: number }[] = [
  { value: "never", label: "Never" },
  { value: "30d", label: "30 days", days: 30 },
  { value: "60d", label: "60 days", days: 60 },
  { value: "90d", label: "90 days", days: 90 },
  { value: "custom", label: "Custom date" },
];

export interface KeyFormData {
  name: string;
  description: string;
  scopePreset: ScopePreset;
  scopes: string[];
  templateIds: string[];
  allTemplates: boolean;
  callbackUrl: string;
  defaultReviewers: string[];
  rateLimit: string;
  expiration: ExpirationPreset;
  expiresAt: string;
  ipAllowlist: string[];
}

export function emptyKeyForm(): KeyFormData {
  return {
    name: "",
    description: "",
    scopePreset: "agent",
    scopes: [...SCOPE_PRESETS.agent],
    templateIds: [],
    allTemplates: true,
    callbackUrl: "",
    defaultReviewers: [],
    rateLimit: "",
    expiration: "never",
    expiresAt: "",
    ipAllowlist: [],
  };
}

export function detectPreset(scopes: string[] | null): ScopePreset {
  if (!scopes) return "admin"; // null = legacy full access
  const sorted = [...scopes].sort().join(",");
  if (sorted === [...SCOPE_PRESETS.agent].sort().join(",")) return "agent";
  if (sorted === [...SCOPE_PRESETS.reviewer].sort().join(",")) return "reviewer";
  if (sorted === [...SCOPE_PRESETS.admin].sort().join(",")) return "admin";
  return "custom";
}

export function apiKeyToForm(c: ApiKey): KeyFormData {
  const preset = detectPreset(c.scopes);
  const existingExpiresAt = c.expires_at ? c.expires_at.slice(0, 10) : "";
  return {
    name: c.name || "",
    description: c.description || "",
    scopePreset: preset,
    scopes: c.scopes ? [...c.scopes] : [...SCOPE_PRESETS.admin],
    templateIds: c.template_ids ?? [],
    allTemplates: !c.template_ids || c.template_ids.length === 0,
    callbackUrl: c.callback_url || "",
    defaultReviewers: c.default_reviewer
      ? c.default_reviewer.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    rateLimit: c.rate_limit_per_hour != null ? String(c.rate_limit_per_hour) : "",
    expiration: existingExpiresAt ? "custom" : "never",
    expiresAt: existingExpiresAt,
    ipAllowlist: c.ip_allowlist ? [...c.ip_allowlist] : [],
  };
}

// Map expiration preset + optional custom date to an ISO string or null.
// Returns undefined if "custom" is selected but the date field is still empty,
// so the caller can skip the field rather than sending an invalid payload.
export function resolveExpiresAt(form: KeyFormData): string | null | undefined {
  if (form.expiration === "never") return null;
  if (form.expiration === "custom") {
    return form.expiresAt ? new Date(form.expiresAt + "T00:00:00Z").toISOString() : undefined;
  }
  const opt = EXPIRATION_OPTIONS.find((o) => o.value === form.expiration);
  if (!opt?.days) return null;
  return new Date(Date.now() + opt.days * 86_400_000).toISOString();
}

// How many days until a key expires. Negative = already expired.
export function daysUntil(isoDate: string): number {
  const diffMs = new Date(isoDate).getTime() - Date.now();
  return Math.ceil(diffMs / 86_400_000);
}

export function formToCreateBody(form: KeyFormData): ApiKeyCreateBody {
  const expires = resolveExpiresAt(form);
  return {
    name: form.name,
    scopes: form.scopes as Scope[],
    description: form.description || undefined,
    template_ids: form.allTemplates ? null : form.templateIds.length > 0 ? form.templateIds : null,
    callback_url: form.callbackUrl || undefined,
    default_reviewer: form.defaultReviewers.length > 0 ? form.defaultReviewers.join(", ") : undefined,
    rate_limit_per_hour: form.rateLimit ? Number(form.rateLimit) : undefined,
    ...(expires !== undefined && { expires_at: expires }),
    ip_allowlist: form.ipAllowlist.length > 0 ? form.ipAllowlist : null,
  };
}

export function formToUpdateBody(form: KeyFormData): ApiKeyUpdateBody {
  const expires = resolveExpiresAt(form);
  return {
    name: form.name,
    description: form.description || null,
    scopes: form.scopes as Scope[],
    template_ids: form.allTemplates ? null : form.templateIds.length > 0 ? form.templateIds : null,
    callback_url: form.callbackUrl || null,
    default_reviewer: form.defaultReviewers.length > 0 ? form.defaultReviewers.join(", ") : null,
    rate_limit_per_hour: form.rateLimit ? Number(form.rateLimit) : null,
    ...(expires !== undefined && { expires_at: expires }),
    ip_allowlist: form.ipAllowlist.length > 0 ? form.ipAllowlist : null,
  };
}

/**
 * The reveal view exists to show a secret exactly once, so reaching it with no
 * secret is the one transition that must be impossible. The server can return
 * a key object whose raw_key is missing (response schema soft-fails open by
 * design in define.ts); this guard is what keeps that defect from rendering an
 * empty reveal panel that the user reads as "my key is the empty string".
 */
export function revealFromResult(result: ApiKeyWithSecret, name: string): { rawKey: string; name: string } | null {
  if (!result.raw_key || typeof result.raw_key !== "string") return null;
  return { rawKey: result.raw_key, name };
}
