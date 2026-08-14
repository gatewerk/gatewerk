/**
 * ListSearchField — the list-column search input, extracted from the History
 * header (History's treatment is the standard).
 * Magnifier, 13px input, a "/" keycap hint while empty, a clear button while
 * not.
 *
 * The keycap is only honest on a screen that also mounts useSlashFocus — a
 * hint for a dead behavior is a defect, so wire both or neither.
 *
 * Escape clears the query first and blurs on a second press, and stops the
 * event outright: without stopPropagation one Escape while typing would also
 * reach useZen and drop the whole shell out of zen mode
 * (feedback_escape_cancel — Escape cancels the NEAREST thing, once).
 */
import { Search, X } from "lucide-react";
import type { RefObject } from "react";

export function ListSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex items-center gap-[9px] rounded-[9px]"
      style={{
        padding: "9px 11px",
        background: "rgba(var(--gw-hi-rgb),.03)",
        border: "1px solid rgba(var(--gw-line-rgb),.09)",
      }}
    >
      <Search size={15} strokeWidth={1.8} className="shrink-0 text-t8" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          e.preventDefault();
          if (value) onChange("");
          else e.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-t2 outline-none placeholder:text-t8"
        style={{ border: "none", fontFamily: "inherit" }}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="flex shrink-0 cursor-pointer border-none bg-transparent p-0 text-t8 transition-colors hover:text-t4"
        >
          <X size={13} />
        </button>
      ) : (
        <span
          className="shrink-0 font-mono text-[11px] text-t10"
          style={{
            border: "1px solid rgba(var(--gw-line-rgb),.10)",
            borderRadius: 5,
            padding: "1px 5px",
          }}
        >
          /
        </span>
      )}
    </div>
  );
}
