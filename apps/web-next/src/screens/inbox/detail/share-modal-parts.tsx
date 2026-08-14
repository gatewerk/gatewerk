/**
 * share-modal-parts.tsx — constants + small presentational pieces for the
 * glass share modal (extracted for the max-lines budget).
 */

export type AuthKey = "public" | "email_otp" | "account";
export type ExpiryKey = "24h" | "7d" | "30d" | "custom";

// Order is the argument: the tier that can prove who decided sits first and
// is the modal's default. A public link stays available, but reaching it is
// now a choice the sharer makes rather than the one they land on. Its
// description names the cost, because a public decision stamps the audit
// actor as `token:<id>` and leaves review_tokens.decided_by_email NULL — the
// only human-readable identity left is recipient_label, free text the sharer
// typed themselves.
export const AUTH_OPTIONS: { key: AuthKey; title: string; desc: string }[] = [
  {
    key: "email_otp",
    title: "Email verification",
    desc: "Recipient confirms the address with a 6 digit code before deciding.",
  },
  {
    key: "public",
    title: "Public link",
    desc: "Anyone with the link can decide. Nothing verifies who they are.",
  },
  {
    key: "account",
    title: "Gatewerk account required",
    desc: "Recipient must log in to decide.",
  },
];

export const EXPIRY_OPTIONS: { key: ExpiryKey; label: string }[] = [
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "custom", label: "Custom" },
];

export const EXPIRY_HOURS: Record<Exclude<ExpiryKey, "custom">, number> = {
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

/** Indent + rule for the field a tier pins (recipient email, recipient user
 *  id). Rendered directly beneath its own option so the rule reads as a
 *  branch off that row rather than off whichever row happens to be last. */
export const CONTEXT_PANEL: React.CSSProperties = {
  marginLeft: 16,
  paddingLeft: 16,
  borderLeft: "2px solid rgba(var(--gw-line-rgb),.12)",
};

export const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  background: "var(--gw-inset)",
  border: "1px solid rgba(var(--gw-line-rgb),.11)",
  borderRadius: 11,
  padding: "13px 15px",
  fontSize: 14,
  color: "var(--gw-t2)",
  outline: "none",
  fontFamily: "inherit",
};

/** Prototype focus recipe: border .28 (+ soft ring on single-line inputs). */
export const FOCUS_RING = {
  onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.28)";
    if (e.currentTarget.tagName === "INPUT") {
      e.currentTarget.style.boxShadow = "0 0 0 3px rgba(var(--gw-line-rgb),.06)";
    }
  },
  onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.11)";
    e.currentTarget.style.boxShadow = "none";
  },
};

export function SegmentedChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer border-none transition-colors"
      style={{
        padding: "7px 15px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? "var(--gw-t2)" : "var(--gw-t6)",
        background: active ? "rgba(var(--gw-line-rgb),.1)" : "transparent",
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}
