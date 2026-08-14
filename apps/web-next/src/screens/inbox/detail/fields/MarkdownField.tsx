/**
 * MarkdownField — multi-line text. Editable inline (raw markdown editing).
 * Rendered as pre-wrapped text (no heavy markdown parser; raw content in a
 * <pre> block preserves line breaks and spacing without adding a dependency).
 */
import { useInlineEdit } from "../use-inline-edit";
import { AutoGrowTextarea } from "../../../../components/AutoGrowTextarea";

interface Props {
  value: unknown;
  editable: boolean;
  onCommit: (v: string) => void;
}

export function MarkdownField({ value, editable, onCommit }: Props) {
  const strVal = typeof value === "string" ? value : value == null ? "" : String(value);

  const { editing, draft, startEdit, updateDraft, handleKeyDown, handleBlur } = useInlineEdit(onCommit);

  if (editing) {
    return (
      <AutoGrowTextarea
        autoFocus
        value={draft}
        rows={3}
        onChange={(e) => updateDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className="w-full rounded-[6px] bg-transparent text-[13px] text-t2 outline-none"
        style={{
          padding: "4px 6px",
          background: "rgba(var(--gw-line-rgb),.04)",
          border: "none",
          boxShadow: "none",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "12.5px",
          lineHeight: "1.6",
        }}
      />
    );
  }

  return (
    <pre
      className="whitespace-pre-wrap break-words rounded-[6px] text-[13.5px] leading-[1.6] transition-colors"
      style={{
        color: "var(--gw-t4)",
        padding: "4px 6px",
        fontFamily: "inherit",
        cursor: editable ? "text" : "default",
      }}
      data-edit={editable ? "line" : undefined}
      onClick={() => editable && startEdit(strVal)}
      onMouseEnter={(e) => {
        if (editable) (e.currentTarget as HTMLElement).style.background = "rgba(var(--gw-line-rgb),.05)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "";
      }}
    >
      {strVal}
    </pre>
  );
}
