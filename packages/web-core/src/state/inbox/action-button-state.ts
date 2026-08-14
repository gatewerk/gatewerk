// Pure helpers for the ActionButton visual state machine. Extracted from
// ActionButton.tsx so the visible-label resolution and Tailwind variant
// lookup are testable without React (apps/web has no jsdom, matches the
// chain-step-indicator-helpers / action-editor-modal-state precedent).
//
// Color/tone is implemented via variantStyle() returning inline CSSProperties
// (CSS var() tokens only — no hex / rgba literals in class strings).
// Structural Tailwind (layout, typography weight, transition) lives in
// STYLE_VARIANTS for the className layer.

import type { CSSProperties } from "react";

export type ActionButtonState = "idle" | "confirming" | "pending" | "success";
export type ActionButtonStyle = "primary" | "destructive" | "secondary" | "warning";

/** Internal tone used by variantStyle. secondary and warning both render as neutral. */
type Tone = "green" | "red" | "neutral";

function styleToTone(style: ActionButtonStyle): Tone {
  if (style === "primary") return "green";
  if (style === "destructive") return "red";
  return "neutral";
}

export interface VisibleLabelArgs {
  state: ActionButtonState;
  label: string;
  successLabel?: string;
}

/**
 * Resolve the label text shown to the user for the current state. Confirming
 * always shows "Confirm?"; success uses successLabel (defaults to label);
 * idle and pending render the canonical label.
 */
export function visibleLabel({ state, label, successLabel }: VisibleLabelArgs): string {
  if (state === "confirming") return "Confirm?";
  if (state === "success") return successLabel ?? label;
  return label;
}

/**
 * Pick the longest of label / successLabel / "Confirm?" for the invisible
 * ghost span that pins the button's content-box width across state
 * transitions. Caller may override with `longestLabel` for templates whose
 * authored copy exceeds the autodetect (e.g. "Permanently delete").
 */
export function widthPinLabel(
  label: string,
  successLabel: string | undefined,
  longestLabel: string | undefined,
): string {
  if (longestLabel !== undefined) return longestLabel;
  const candidates = [label, successLabel ?? label, "Confirm?"];
  let best = candidates[0];
  for (const c of candidates) {
    if (c.length > best.length) best = c;
  }
  return best;
}

interface VariantSet {
  idle: string;
  confirming: string;
  pending: string;
}

// Structural Tailwind classes only — no color classes, no hex, no rgba.
// Color is provided by variantStyle() as inline CSS var() properties.
// Pending and success share the same structural variant; success uses the
// same classes so the morph stays continuous through the success flash.
export const STYLE_VARIANTS: Record<ActionButtonStyle, VariantSet> = {
  primary: {
    idle:      "font-semibold transition-all",
    confirming: "font-semibold transition-all ring-2 ring-inset",
    pending:   "font-semibold transition-all opacity-85",
  },
  destructive: {
    idle:      "font-semibold transition-all",
    confirming: "font-semibold transition-all ring-2 ring-inset",
    pending:   "font-semibold transition-all opacity-85",
  },
  secondary: {
    idle:      "font-medium transition-all",
    confirming: "font-medium transition-all ring-2 ring-inset",
    pending:   "font-medium transition-all opacity-85",
  },
  warning: {
    idle:      "font-medium transition-all",
    confirming: "font-medium transition-all ring-2 ring-inset",
    pending:   "font-medium transition-all opacity-85",
  },
};

/**
 * Map (style, state) to the structural Tailwind class string for the button.
 * Pending and success share the same variant — use variantStyle() for the
 * color/tone layer which distinguishes them visually.
 */
export function variantClasses(
  style: ActionButtonStyle,
  state: ActionButtonState,
): string {
  const variants = STYLE_VARIANTS[style];
  if (state === "confirming") return variants.confirming;
  if (state === "pending" || state === "success") return variants.pending;
  return variants.idle;
}

/**
 * 3-tone color system (warm-precision standard). Returns inline CSSProperties
 * so the component can apply them via style={} — CSS var() tokens only.
 *
 * Tones:
 *   green  (primary)            — solid fill var(--gw-green), hover var(--gw-green-h) + shadow.
 *   red    (destructive)        — outline rgba(var(--gw-red-rgb),.32), bg .08, text var(--gw-red-t).
 *   neutral (secondary/warning) — outline rgba(var(--gw-line-rgb),.13), text var(--gw-t5).
 *
 * State overrides:
 *   confirming — brightened same-tone treatment (ring highlight, slightly deeper bg).
 *   pending    — opacity .85 (structural class) + same idle colors.
 *   success    — soft same-tone fill + matching text (distinct from pending fill).
 *   disabled   — opacity .38 applied by the caller via disabled:opacity-38 or `disabled` attr.
 */
export function variantStyle(
  style: ActionButtonStyle,
  state: ActionButtonState,
  isPrimary?: boolean,
): CSSProperties {
  const tone = styleToTone(style);

  const base: CSSProperties = {
    height: isPrimary ? 40 : 38,
    fontSize: tone === "neutral" ? 13 : 13,
    transition: "all .12s",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 9,
    paddingLeft: 16,
    paddingRight: 16,
    cursor: "pointer",
    width: "100%",
  };

  if (state === "success") {
    switch (tone) {
      case "green":
        return { ...base, background: "rgba(var(--gw-green-rgb),.16)", color: "var(--gw-green-d)", border: "none" };
      case "red":
        return { ...base, background: "rgba(var(--gw-red-rgb),.16)", color: "var(--gw-red-done)", border: "none" };
      default:
        return { ...base, background: "rgba(var(--gw-line-rgb),.10)", color: "var(--gw-t3)", border: "none" };
    }
  }

  if (state === "confirming") {
    switch (tone) {
      case "green":
        return { ...base, background: "rgba(var(--gw-green-rgb),.18)", color: "var(--gw-green)", border: "none" };
      case "red":
        return { ...base, background: "rgba(var(--gw-red-rgb),.15)", color: "var(--gw-red-t)", border: "1px solid rgba(var(--gw-red-rgb),.5)" };
      default:
        return { ...base, background: "rgba(var(--gw-line-rgb),.06)", color: "var(--gw-t3)", border: "1px solid rgba(var(--gw-line-rgb),.20)" };
    }
  }

  // idle and pending share the same color treatment; pending opacity is handled
  // by the structural class in STYLE_VARIANTS.
  switch (tone) {
    case "green":
      return { ...base, background: "var(--gw-green)", color: "var(--gw-green-ink)", border: "none" };
    case "red":
      return { ...base, background: "rgba(var(--gw-red-rgb),.08)", color: "var(--gw-red-t)", border: "1px solid rgba(var(--gw-red-rgb),.32)" };
    default:
      return { ...base, background: "transparent", color: "var(--gw-t5)", border: "1px solid rgba(var(--gw-line-rgb),.13)" };
  }
}

/**
 * Hover overlay for idle state only — merged over the base variantStyle() by
 * ActionButton's onMouseEnter handler. Returns undefined for any non-idle
 * state so callers can gate application with a simple truthiness check.
 *
 * Values per tone (3-tone warm-precision standard):
 *   green   — bg var(--gw-green-h) + boxShadow 0 2px 10px rgba(var(--gw-green-rgb),0.28)
 *   red     — border rgba(var(--gw-red-rgb),0.5), bg rgba(var(--gw-red-rgb),0.15), text var(--gw-red-done)
 *   neutral — border rgba(var(--gw-line-rgb),0.2), bg rgba(var(--gw-line-rgb),0.06), text var(--gw-t3)
 */
export function variantHoverStyle(
  style: ActionButtonStyle,
  state: ActionButtonState,
): CSSProperties | undefined {
  if (state !== "idle") return undefined;
  const tone = styleToTone(style);
  switch (tone) {
    case "green":
      return {
        background: "var(--gw-green-h)",
        boxShadow: "0 2px 10px rgba(var(--gw-green-rgb),0.28)",
      };
    case "red":
      return {
        border: "1px solid rgba(var(--gw-red-rgb),0.5)",
        background: "rgba(var(--gw-red-rgb),0.15)",
        color: "var(--gw-red-done)",
      };
    default:
      return {
        border: "1px solid rgba(var(--gw-line-rgb),0.2)",
        background: "rgba(var(--gw-line-rgb),0.06)",
        color: "var(--gw-t3)",
      };
  }
}
