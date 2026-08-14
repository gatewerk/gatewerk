/**
 * ActionButton — 3-tone stateful rail button (label-only, no icons).
 *
 * Tones: green (primary/approve), red (destructive/reject), neutral.
 * States: idle | loading | disabled | done
 *
 * Anatomy — one height, one radius, one type size across all three tones:
 *   h-42 / radius-10 / label-13.5px / full width.
 *   green:   bg var(--gw-green), text #0a1a11, 600, inset top highlight
 *   red:     transparent, border rgba(red,.28), text var(--gw-red-t), 550
 *   neutral: transparent, border rgba(line,.12), text var(--gw-t5), 500
 *
 * Reject stays quiet (border only) rather than a permanent red fill, and
 * takes its fill on hover: a destructive secondary should not shout as
 * loudly as the primary at rest.
 *
 * Loading → spinner (15px) in the icon slot, label held, button at 85% opacity.
 * Done → soft same-tone fill + label stays.
 * Disabled → 38% opacity.
 */
import { Loader2 } from "lucide-react";
import type { ActionTone } from "./action-tones";

export type ActionButtonState = "idle" | "loading" | "disabled" | "done";

interface Props {
  label: string;
  tone: ActionTone;
  state?: ActionButtonState;
  onClick?: () => void;
}

/** Shared by every tone: the pair must read as one block, not two controls. */
function baseStyles(state: ActionButtonState): React.CSSProperties {
  return {
    height: 42,
    borderRadius: 10,
    fontSize: 13.5,
    letterSpacing: "-.01em",
    cursor: state === "disabled" || state === "loading" ? "default" : "pointer",
    opacity: state === "disabled" ? 0.38 : state === "loading" ? 0.85 : 1,
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background .12s, opacity .12s, border-color .12s",
  };
}

function toneStyles(tone: ActionTone, state: ActionButtonState): React.CSSProperties {
  const done = state === "done";
  const base = baseStyles(state);

  switch (tone) {
    case "green":
      return {
        ...base,
        border: "none",
        background: done ? "rgba(33,181,113,.16)" : "var(--gw-green)",
        color: done ? "var(--gw-green-d)" : "var(--gw-green-ink)",
        fontWeight: 600,
        // The same inset top highlight the app's raised surfaces carry, so
        // the primary sits on the rail rather than being painted onto it.
        boxShadow: done ? undefined : "inset 0 1px 0 rgba(255,255,255,.16)",
      };
    case "red":
      return {
        ...base,
        border: done ? "none" : "1px solid rgba(var(--gw-red-rgb),.28)",
        background: done ? "rgba(var(--gw-red-rgb),.16)" : "transparent",
        color: "var(--gw-red-t)",
        fontWeight: 550,
      };
    case "neutral":
      return {
        ...base,
        border: done ? "none" : "1px solid rgba(var(--gw-line-rgb),.12)",
        background: done ? "rgba(var(--gw-line-rgb),.10)" : "transparent",
        color: "var(--gw-t5)",
        fontWeight: 500,
      };
    default: {
      // assertNever: exhaustive check — TS will error if a tone is added without handling.
      const _never: never = tone;
      void _never;
      return {};
    }
  }
}

function hoverBackground(tone: ActionTone, state: ActionButtonState): string | undefined {
  if (state !== "idle") return undefined;
  switch (tone) {
    case "green": return "var(--gw-green-h)";
    // Reject is calm until the pointer says otherwise; this is where its
    // fill arrives, rather than sitting on the rail permanently.
    case "red": return "rgba(var(--gw-red-rgb),.12)";
    case "neutral": return "rgba(var(--gw-line-rgb),.08)";
  }
}

export function ActionButton({ label, tone, state = "idle", onClick }: Props) {
  const styles = toneStyles(tone, state);
  const isLoading = state === "loading";
  const isDisabled = state === "disabled" || state === "loading";
  const hoverBg = hoverBackground(tone, state);

  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={isLoading}
      style={styles}
      onClick={isDisabled ? undefined : onClick}
      onMouseEnter={hoverBg ? (e) => { (e.currentTarget as HTMLButtonElement).style.background = hoverBg; } : undefined}
      onMouseLeave={hoverBg ? (e) => {
        (e.currentTarget as HTMLButtonElement).style.background = styles.background as string ?? "transparent";
      } : undefined}
    >
      {isLoading && (
        <Loader2
          size={15}
          className="animate-spin"
          aria-hidden="true"
          style={{ marginRight: 7, flexShrink: 0 }}
        />
      )}
      <span>{label}</span>
    </button>
  );
}
