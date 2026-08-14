/**
 * One templates-list row: name, then a mono meta line.
 *
 * Deliberately the same anatomy as `screens/inbox/ReviewRow` — title in sans,
 * a mono second line, selection drawn as an inset hairline plus a faint fill —
 * so the two lists read as one product rather than two screens that happen to
 * share a shell.
 */
import { timeAgoShort } from "@gatewerk/web-core/lib/utils";
import { templateMetaParts, type TemplateListItem } from "./template-filters";

export function TemplateRow({
  template,
  isSelected,
  onClick,
}: {
  template: TemplateListItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  // Inactive templates dim rather than carrying a badge: the meta line already
  // says "Inactive", and a second marker would make the quietest row the
  // loudest one.
  const dimmed = template.status === "inactive" && !isSelected;

  // Metrics are ReviewRow's/HistoryRow's exactly (r11, 11px 13px padding, 7px
  // title-to-meta gap, t4 title, selection as an always-present border so the
  // list never shifts, hover tint) — one row
  // language across every list column.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "true" : undefined}
      className="gw-focus-ring w-full cursor-pointer rounded-[11px] text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),.03)]"
      style={{
        padding: "11px 13px",
        background: isSelected ? "rgba(var(--gw-hi-rgb),.05)" : undefined,
        border: isSelected
          ? "1px solid rgba(var(--gw-line-rgb),.09)"
          : "1px solid transparent",
        opacity: dimmed ? 0.85 : 1,
      }}
    >
      {/* Title shares its line with a right-aligned age, like the other
          lists' rows — a title alone on an empty line reads bigger than it
          is. */}
      <span className="flex w-full items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate text-[14px]"
          style={{ color: isSelected ? "var(--gw-t1)" : "var(--gw-t4)", fontWeight: isSelected ? 600 : 550 }}
        >
          {template.name || "Untitled template"}
        </span>
        {template.updated_at && (
          <span className="shrink-0" style={{ fontSize: 11.5, color: "var(--gw-t8)" }}>
            {timeAgoShort(template.updated_at)}
          </span>
        )}
      </span>
      {/* Parts separated by space alone, all in the quiet ink: the line reads
          "4 fields" until something non-default (a draft, a set priority, a
          chain) earns a word. No color — a template's priority is
          configuration, not a live alarm. */}
      <span
        className="flex w-full items-baseline overflow-hidden font-mono text-[11px]"
        style={{ marginTop: 7, gap: 10, color: "var(--gw-t7)" }}
      >
        {templateMetaParts(template).map((part) => (
          <span key={part} className="truncate whitespace-nowrap">
            {part}
          </span>
        ))}
      </span>
    </button>
  );
}
