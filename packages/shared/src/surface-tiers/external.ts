/** surface-tiers/external — external review links and the recipient's own writes. */
import type { AxisDeclaration } from "./types";
import type { TokenAxis, RecipientAxis } from "./axes";

// ---------------------------------------------------------------------------
// External review links — NOT TYPE-ENFORCED, see TokenAxis
// ---------------------------------------------------------------------------

export const TOKEN_AXES: Record<TokenAxis, AxisDeclaration> = {
  recipient_label: {
    tier: "core",
    surface: "share-link-dialog",
    group: "link",
    note: "Required, and omitted by the TS SDK, the Python SDK and the n8n node — all three 422 on every link they try to mint. The root cause is a second, 1-key schema of the same name in packages/shared that the SDKs mirror.",
  },
  purpose: { tier: "advanced", surface: "share-link-dialog", group: "link" },
  note: { tier: "advanced", surface: "share-link-dialog", group: "link" },
  expiryHours: {
    tier: "advanced",
    surface: "share-link-dialog",
    group: "link",
    note: "Template default_expiry_seconds is NOT consulted here; the service applies its own 48h.",
  },
  auth_level: {
    tier: "advanced",
    surface: "share-link-dialog",
    group: "link",
    note: "All three values surface in the share modal (email_otp first and default, then public, then account) The account tier still has no server-side org-membership check, so the tier match is raw string equality — see auth_user_id.",
  },
  auth_email: { tier: "advanced", surface: "share-link-dialog", group: "link", note: "Required iff email_otp. Masked to the recipient." },
  preview: { tier: "advanced", surface: "share-link-dialog", group: "link", note: "5-minute TTL, unspendable, excluded from history." },
  "extend.hours": { tier: "advanced", surface: "share-link-dialog", group: "link", note: "Additive with no ceiling beyond the 720h per-call cap." },
  "revoke.reason": { tier: "advanced", surface: "share-link-dialog", group: "link", note: "Audit-only. Revoke atomically pulls the review back to pending." },

  auth_user_id: {
    tier: "advanced",
    surface: "share-link-dialog",
    group: "link",
    note: "RETIERED roadmap → advanced: the share modal's AUTH_OPTIONS include 'Gatewerk account required' and selecting it pins a recipient-user-id input, so the axis is in the launch UI beside auth_email (the Account settings pane even offers Copy user ID to feed it). ⚠️ The reason it was held is still true and unfixed: there is no server-side org-membership check — the account-tier match is raw string equality.",
  },
};

// ---------------------------------------------------------------------------
// The external recipient's own writes — NOT TYPE-ENFORCED
// ---------------------------------------------------------------------------

export const RECIPIENT_AXES: Record<RecipientAxis, AxisDeclaration> = {
  "decline.decline_reason": { tier: "request", note: "Optional, 1..1000." },
  "raise_questions.question_text": { tier: "request", note: "Required, 10..5000. Becomes a persisted note." },
};
