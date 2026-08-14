/**
 * DecisionRow — the recipient's decision buttons (§4d) and the two quiet ghost
 * links below them (§4e).
 *
 * Design: Gatewerk External Review.dc.html:93-104 (markup) and :207-210 (button
 * visuals). Buttons render in the template's canonical action order, exactly as
 * the prototype does (it applies no sorting of its own); the primary is
 * emphasized by width (`flex:1.35`), not by position.
 *
 * Two-step confirm is mandatory on this surface: `withRecipientSafety` forces
 * `confirmation:true` on every action because the recipient has no undo and no
 * app context. No focus lift on mount: the design shows no focused control, and
 * a pre-focused decision button turns a stray Enter into an arming keystroke.
 */

import { useState } from "react";
import { HelpCircle, Loader2, X } from "lucide-react";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";

type Tone = "primary" | "destructive" | "neutral";

function toneOf(action: TemplateActionConfigCanonical): Tone {
  if (action.style === "destructive" || action.decision_value === "rejected")
    return "destructive";
  if (action.style === "primary" || action.style === undefined) return "primary";
  return "neutral";
}

const BASE: React.CSSProperties = {
  height: 48,
  borderRadius: 12,
  fontFamily: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  transition: "background .14s, border-color .14s, transform .1s",
};

function restStyle(tone: Tone): React.CSSProperties {
  switch (tone) {
    case "primary":
      return {
        ...BASE,
        flex: 1.35,
        border: "none",
        background: "var(--gw-green)",
        color: "var(--gw-green-ink)",
        fontSize: 14.5,
        boxShadow:
          "0 1px 0 rgba(var(--gw-line-rgb),.14) inset, 0 6px 18px rgba(var(--gw-green-rgb),.16)",
      };
    case "destructive":
      return {
        ...BASE,
        flex: 1,
        border: "1px solid rgba(var(--gw-red-rgb),.28)",
        background: "transparent",
        color: "var(--gw-red-t)",
        fontSize: 14,
      };
    case "neutral":
      return {
        ...BASE,
        flex: 1,
        border: "1px solid rgba(var(--gw-line-rgb),.14)",
        background: "transparent",
        color: "var(--gw-t5)",
        fontSize: 14,
      };
  }
}

function hoverStyle(tone: Tone): React.CSSProperties {
  switch (tone) {
    case "primary":
      return { background: "var(--gw-green-h)" };
    case "destructive":
      return {
        borderColor: "rgba(var(--gw-red-rgb),.5)",
        background: "rgba(var(--gw-red-rgb),.09)",
        color: "var(--gw-red-t)",
      };
    case "neutral":
      return {
        background: "rgba(var(--gw-line-rgb),.06)",
        color: "var(--gw-t2)",
      };
  }
}

/** Armed (confirm-pending) ring; tone-matched, never a new hue. */
function armedStyle(tone: Tone): React.CSSProperties {
  switch (tone) {
    case "primary":
      return {
        background: "var(--gw-green-h)",
        boxShadow:
          "0 1px 0 rgba(var(--gw-line-rgb),.14) inset, 0 0 0 2px rgba(var(--gw-green-rgb),.45)",
      };
    case "destructive":
      return {
        background: "rgba(var(--gw-red-rgb),.12)",
        boxShadow: "0 0 0 2px rgba(var(--gw-red-rgb),.4)",
      };
    case "neutral":
      return {
        background: "rgba(var(--gw-line-rgb),.08)",
        boxShadow: "0 0 0 2px rgba(var(--gw-line-rgb),.2)",
      };
  }
}

function DecisionButton({
  action,
  armed,
  pending,
  disabled,
  onClick,
}: {
  action: TemplateActionConfigCanonical;
  armed: boolean;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = toneOf(action);
  const style: React.CSSProperties = {
    ...restStyle(tone),
    ...(hovered && !disabled ? hoverStyle(tone) : {}),
    ...(armed ? armedStyle(tone) : {}),
    ...(disabled ? { opacity: 0.38, cursor: "not-allowed" } : {}),
    ...(pending ? { opacity: 0.85, cursor: "default" } : {}),
  };
  return (
    <button
      type="button"
      className="gw-focus-ring"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        if (!disabled) e.currentTarget.style.transform = "scale(.985)";
      }}
      onMouseUp={(e) => (e.currentTarget.style.transform = "none")}
      style={style}
    >
      {pending && <Loader2 size={14} className="animate-spin" />}
      {armed ? `Confirm ${action.label}` : action.label}
    </button>
  );
}

interface Props {
  actions: TemplateActionConfigCanonical[];
  armedId: string | null;
  pendingId: string | null;
  /** Preview tokens and in-flight mutations disable the whole row. */
  disabled: boolean;
  onAction: (action: TemplateActionConfigCanonical) => void;
  onDecline: () => void;
  onQuestions: () => void;
}

export function DecisionRow({
  actions,
  armedId,
  pendingId,
  disabled,
  onAction,
  onDecline,
  onQuestions,
}: Props) {
  return (
    <>
      <div className="flex" style={{ gap: 10 }}>
        {actions.map((a) => (
          <DecisionButton
            key={a.id}
            action={a}
            armed={armedId === a.id}
            pending={pendingId === a.id}
            disabled={disabled || (pendingId !== null && pendingId !== a.id)}
            onClick={() => onAction(a)}
          />
        ))}
      </div>

      <div
        className="flex items-center justify-center"
        style={{ gap: 20, paddingTop: 4 }}
      >
        <GhostLink
          label="Decline"
          hoverColor="var(--gw-red-t)"
          disabled={disabled}
          onClick={onDecline}
          icon={<X size={13} strokeWidth={2.2} />}
        />
        <span
          style={{
            width: 1,
            height: 12,
            background: "rgba(var(--gw-line-rgb),.12)",
          }}
        />
        <GhostLink
          label="Send back with questions"
          hoverColor="var(--gw-amber-t)"
          disabled={disabled}
          onClick={onQuestions}
          icon={<HelpCircle size={13} strokeWidth={2} />}
        />
      </div>
    </>
  );
}

function GhostLink({
  label,
  icon,
  hoverColor,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  hoverColor: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="gw-focus-ring inline-flex items-center border-none bg-transparent p-0"
      style={{
        gap: 6,
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: 500,
        color: hovered && !disabled ? hoverColor : "var(--gw-t7)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.38 : 1,
        transition: "color .12s",
      }}
    >
      {icon}
      {label}
    </button>
  );
}
