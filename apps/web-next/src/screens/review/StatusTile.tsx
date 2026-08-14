/**
 * StatusTile — the one shape every terminal state uses: icon tile, title,
 * description, optional "Sent by" line, optional CTA.
 *
 * Spec §6. Design: Gatewerk External Review.dc.html:109-117 (markup) and
 * :177-205 (per-state icon / tone / copy).
 */

import { useState } from "react";
import { Check, Clock, HelpCircle, LogIn, ShieldAlert, X } from "lucide-react";
import {
  STATUS_COPY,
  type StatusIcon,
  type StatusKind,
  type StatusTone,
} from "./recipient-state";

const TONE: Record<StatusTone, { color: string; tile: string }> = {
  green: { color: "var(--gw-green-d)", tile: "rgba(var(--gw-green-rgb),.14)" },
  red: { color: "var(--gw-red-t)", tile: "rgba(var(--gw-red-rgb),.1)" },
  amber: { color: "var(--gw-amber-t)", tile: "rgba(var(--gw-amber-rgb),.12)" },
  neutral: { color: "var(--gw-t4)", tile: "rgba(var(--gw-line-rgb),.06)" },
};

function TileIcon({ icon, color }: { icon: StatusIcon; color: string }) {
  // Check / X are drawn heavier and larger than the outline glyphs (proto:180-185).
  switch (icon) {
    case "check":
      return <Check size={26} strokeWidth={2.4} color={color} />;
    case "cross":
      return <X size={26} strokeWidth={2.4} color={color} />;
    case "clock":
      return <Clock size={24} strokeWidth={1.9} color={color} />;
    case "shield":
      return <ShieldAlert size={24} strokeWidth={1.9} color={color} />;
    case "login":
      return <LogIn size={24} strokeWidth={1.9} color={color} />;
    case "question":
      return <HelpCircle size={24} strokeWidth={1.9} color={color} />;
  }
}

function CtaButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      className="gw-focus-ring"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        marginTop: 22,
        height: 42,
        padding: "0 22px",
        borderRadius: 11,
        border: "none",
        background: hovered ? "var(--gw-green-h)" : "var(--gw-green)",
        color: "var(--gw-green-ink)",
        fontFamily: "inherit",
        fontSize: 13.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

interface Props {
  kind: StatusKind;
  /** Overrides the static description (used / mismatch / error). */
  description?: string;
  senderHint?: string;
  onCta?: () => void;
}

export function StatusTile({ kind, description, senderHint, onCta }: Props) {
  const copy = STATUS_COPY[kind];
  const tone = TONE[copy.tone];

  return (
    <div
      className="flex flex-col items-center text-center"
      style={{ padding: "44px 0 30px" }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 56,
          height: 56,
          borderRadius: 18,
          marginBottom: 18,
          background: tone.tile,
        }}
      >
        <TileIcon icon={copy.icon} color={tone.color} />
      </div>

      <h1
        className="font-display text-t1"
        style={{ margin: 0, fontSize: 19, fontWeight: 600 }}
      >
        {copy.title}
      </h1>

      <p
        style={{
          margin: "9px 0 0",
          maxWidth: 360,
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--gw-t5)",
        }}
      >
        {description ?? copy.desc}
      </p>

      {copy.sender && senderHint && (
        <p style={{ margin: "9px 0 0", fontSize: 12, color: "var(--gw-t8)" }}>
          Sent by{" "}
          <span style={{ color: "var(--gw-t4)", fontWeight: 500 }}>
            {senderHint}
          </span>
        </p>
      )}

      {copy.cta && onCta && <CtaButton label={copy.cta} onClick={onCta} />}
    </div>
  );
}
