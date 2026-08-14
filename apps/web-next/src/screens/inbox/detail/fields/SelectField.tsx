import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";

interface Props {
  value: unknown;
  editable: boolean;
  options?: string[];
  onCommit: (v: string) => void;
}

/**
 * SelectField — prototype selChipStyle + dropdown (lines 259, 2137-2143):
 * editable chip: sans 13px t3, bg rgba(line,.05), border rgba(line,.12),
 * radius 7, padding 4px 11px, gap 7, chevron 12px t8.
 * locked chip: 13px t3 (same as editable — a locked value is still primary
 * content a reviewer must read, not a disabled control), bg --gw-inset-soft,
 * border rgba(line,.07). Only the chip's shape carries the lock/edit
 * distinction now, not the text's legibility.
 * Dropdown: min-w 172, glass .74 blur(18px) sat(140%), radius 9, shadow
 * 0 14px 36px rgba(0,0,0,.5) + inset top line, padding 5px, rows 7px 10px
 * radius 6 with a TRAILING 13px green check on the selected option.
 */
export function SelectField({ value, editable, options = [], onCommit }: Props) {
  const strVal = typeof value === "string" ? value : value == null ? "" : String(value);
  const [open, setOpen] = useState(false);

  const chip = (
    <span
      className="inline-flex items-center text-[13px]"
      style={
        editable
          ? {
              gap: 7,
              color: "var(--gw-t3)",
              background: "rgba(var(--gw-line-rgb),.05)",
              border: "1px solid rgba(var(--gw-line-rgb),.12)",
              borderRadius: 7,
              padding: "4px 11px",
            }
          : {
              color: "var(--gw-t3)",
              background: "var(--gw-inset-soft)",
              border: "1px solid rgba(var(--gw-line-rgb),.07)",
              borderRadius: 7,
              padding: "4px 11px",
            }
      }
    >
      {strVal}
      {editable && (
        <ChevronDown
          size={12}
          strokeWidth={2}
          style={{
            color: "var(--gw-t8)",
            transition: "transform .15s",
            transform: open ? "rotate(180deg)" : undefined,
          }}
        />
      )}
    </span>
  );

  if (!editable) return chip;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer border-none bg-transparent p-0"
        style={{ appearance: "none", fontFamily: "inherit" }}
      >
        {chip}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[39]" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 z-[40] flex flex-col"
            style={{
              top: "calc(100% + 5px)",
              minWidth: 172,
              gap: 1,
              padding: 5,
              background: "rgba(var(--gw-glass-rgb),.74)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              borderRadius: 9,
              boxShadow:
                "0 14px 36px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                className="flex w-full cursor-pointer items-center border-none text-left text-[13px] transition-colors"
                style={{
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 6,
                  background: "transparent",
                  color: opt === strVal ? "var(--gw-t2)" : "var(--gw-t4)",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.06)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={() => { onCommit(opt); setOpen(false); }}
              >
                <span className="min-w-0 flex-1 truncate">{opt}</span>
                {opt === strVal && (
                  <Check size={13} strokeWidth={2.4} style={{ color: "var(--gw-green-t)", flexShrink: 0 }} />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
