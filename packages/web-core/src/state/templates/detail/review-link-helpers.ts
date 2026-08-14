import { TOKEN_EXPIRY_SECONDS } from "@gatewerk/shared";

// Spec section 8.5. Discriminated union over the 3 supported auth tiers.
// Moved from template-editor/_helpers.ts so the live editor can share the
// same coercion semantics without importing the orphaned editor tree.
export type DefaultAuthLevel = "public" | "email_otp" | "account";

export function coerceAuthLevel(raw: unknown): DefaultAuthLevel {
  if (raw === "email_otp" || raw === "account") return raw;
  // Anything else (including undefined, malformed, or future-unknown
  // values) falls back to public — matches DB default and keeps the editor
  // safe in the face of bad payloads.
  return "public";
}

export function coerceExpirySeconds(raw: unknown): number {
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw > 0 &&
    raw <= TOKEN_EXPIRY_SECONDS.MAX
  ) {
    return raw;
  }
  return TOKEN_EXPIRY_SECONDS.TEMPLATE_DEFAULT;
}

// Draft-over-column-over-fallback resolution for the 3 review-link fields.
// Extracted so TemplateDetail's eff branches, seed effect, handleCancel, and
// handleDiscard all use a single tested path instead of inline ?? chains.
export function resolveReviewLinkFields(
  draft: Record<string, unknown> | null | undefined,
  template: Record<string, unknown>,
): {
  enableReviewLinks: boolean;
  defaultAuthLevel: DefaultAuthLevel;
  defaultExpirySeconds: number;
} {
  if (draft) {
    return {
      enableReviewLinks: Boolean(draft.enable_review_links ?? template.enable_review_links ?? false),
      defaultAuthLevel: coerceAuthLevel(draft.default_auth_level ?? template.default_auth_level),
      defaultExpirySeconds: coerceExpirySeconds(draft.default_expiry_seconds ?? template.default_expiry_seconds),
    };
  }
  return {
    enableReviewLinks: Boolean(template.enable_review_links ?? false),
    defaultAuthLevel: coerceAuthLevel(template.default_auth_level),
    defaultExpirySeconds: coerceExpirySeconds(template.default_expiry_seconds),
  };
}

// Maps the component state triple back to draft-config keys.
// Having the EXACT key spellings in one tested place eliminates the passthrough-typo
// risk (DraftConfigSchema is a passthrough z.record — typos silently strand values).
export function buildReviewLinkDraftFields(state: {
  enableReviewLinks: boolean;
  defaultAuthLevel: DefaultAuthLevel;
  defaultExpirySeconds: number;
}): {
  enable_review_links: boolean;
  default_auth_level: DefaultAuthLevel;
  default_expiry_seconds: number;
} {
  return {
    enable_review_links: state.enableReviewLinks,
    default_auth_level: state.defaultAuthLevel,
    default_expiry_seconds: state.defaultExpirySeconds,
  };
}
