/**
 * SeePreviousVersion — per-field disclosure when staged value differs from
 * submitted value (prototype prevOpen/togglePrev block).
 *
 * Toggle: 11.5px/500 --gw-blue-t, gap 6, chevron-down rotating 180° open,
 * hover --gw-blue-h. Expanded block: NO fill/radius — an amber left rule
 * (2px rgba(var(--gw-amber-rgb),.4)), padding 2px 0 2px 12px, flex row with
 * the original value (sans 12.5px/1.5 --gw-t6, pre-wrap) and an inline
 * Revert control at the right (11.5px/500 --gw-red-t, hover opacity .8).
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface Props {
  originalValue: unknown;
  onRevert: () => void;
}

function renderOriginal(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function SeePreviousVersion({ originalValue, onRevert }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginTop: 7 }}>
      <button
        type="button"
        className="flex cursor-pointer items-center border-none bg-transparent p-0 text-[11.5px] font-medium transition-colors"
        style={{ gap: 6, color: "var(--gw-blue-t)", fontFamily: "inherit" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gw-blue-h)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gw-blue-t)")}
        onClick={() => setExpanded((e) => !e)}
      >
        <ChevronDown
          size={11}
          style={{
            transition: "transform .15s",
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
        See previous version
      </button>

      {expanded && (
        <div
          className="flex items-start"
          style={{
            marginTop: 7,
            gap: 12,
            borderLeft: "2px solid rgba(var(--gw-amber-rgb),.4)",
            padding: "2px 0 2px 12px",
          }}
        >
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12.5px]"
            style={{ color: "var(--gw-t6)", lineHeight: 1.5 }}
          >
            {renderOriginal(originalValue)}
          </div>
          <button
            type="button"
            className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-medium transition-opacity hover:opacity-80"
            style={{ color: "var(--gw-red-t)", fontFamily: "inherit" }}
            onClick={() => {
              onRevert();
              setExpanded(false);
            }}
          >
            Revert
          </button>
        </div>
      )}
    </div>
  );
}
