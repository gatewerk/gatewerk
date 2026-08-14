/**
 * StatusBadge — the app's status chip in its two shipped shapes.
 * "bordered" is ReviewRow's decided/not-delivered recipe (transparent bg,
 * 1px tone border, 9.5px tracked mono); "filled" is DeliveriesPane's
 * delivery-status recipe (tone-tinted bg, 9px mono). They are deliberately
 * NOT merged into one look — both ship, pixel-identical to their origins.
 * Tone-to-meaning mapping and label copy stay at the call sites; a healthy
 * state renders no badge at all (app-wide convention: only trouble and
 * outcomes earn color, silence is the default).
 */
import { type ReactNode } from "react";

export type BorderedTone = "green" | "red" | "neutral";
export type FilledTone = "red" | "amber";

// The green border literal is byte identical to rgba(var(--gw-green-rgb),.35)
// in both themes (tokens.css defines --gw-green-rgb in :root only, as the
// fixed anchor that html.gw-light never overrides). It is carried verbatim
// from DecidedChip so this branch stays provably zero pixel; swapping in the
// token is a safe follow-up, deferred on purpose because StatusBadge.test.tsx
// pins jsdom's numeric serialization of this literal.
const BORDERED: Record<BorderedTone, { color: string; borderColor: string }> = {
  green: { color: "var(--gw-green-d)", borderColor: "rgba(33,181,113,.35)" },
  red: { color: "var(--gw-red-t)", borderColor: "rgba(var(--gw-red-rgb),.35)" },
  neutral: { color: "rgba(var(--gw-line-rgb),.5)", borderColor: "rgba(var(--gw-line-rgb),.2)" },
};

const FILLED: Record<FilledTone, { background: string; color: string }> = {
  red: { background: "rgba(var(--gw-red-rgb),.1)", color: "var(--gw-red-t)" },
  amber: { background: "rgba(var(--gw-amber-rgb),.1)", color: "var(--gw-amber-t)" },
};

export function StatusBadge(
  props:
    | { variant?: "bordered"; tone: BorderedTone; children: ReactNode }
    | { variant: "filled"; tone: FilledTone; children: ReactNode },
) {
  if (props.variant === "filled") {
    return (
      <span
        className="shrink-0 rounded-[4px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase"
        style={FILLED[props.tone]}
      >
        {props.children}
      </span>
    );
  }
  const t = BORDERED[props.tone];
  return (
    <span
      className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em]"
      style={{ color: t.color, border: `1px solid ${t.borderColor}`, borderRadius: 4, padding: "2px 6px" }}
    >
      {props.children}
    </span>
  );
}
