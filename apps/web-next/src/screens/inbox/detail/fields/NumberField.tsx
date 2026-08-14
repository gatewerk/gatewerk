import { useInlineEdit } from "../use-inline-edit";

interface Props {
  value: unknown;
  editable: boolean;
  onCommit: (v: number) => void;
}

export function NumberField({ value, editable, onCommit }: Props) {
  const numVal = typeof value === "number" ? value : value == null ? null : Number(value);
  const strVal = numVal == null ? "" : String(numVal);

  const {
    editing,
    draft,
    startEdit,
    updateDraft,
    handleKeyDown: rawKeyDown,
    handleBlur,
  } = useInlineEdit((s) => onCommit(Number(s)));

  const handleKeyDown = (e: React.KeyboardEvent) => rawKeyDown(e);

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={draft}
        onChange={(e) => updateDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className="rounded-[6px] bg-transparent text-[15px] font-semibold tabular-nums text-t2 outline-none"
        style={{
          padding: "2px 4px",
          background: "rgba(var(--gw-line-rgb),.04)",
          border: "none",
          boxShadow: "none",
          fontVariantNumeric: "tabular-nums",
          width: "120px",
        }}
      />
    );
  }

  return (
    <span
      className="cursor-text rounded-[6px] text-[15px] font-semibold tabular-nums transition-colors"
      style={{
        padding: "2px 4px",
        color: "var(--gw-t1)",
        fontVariantNumeric: "tabular-nums",
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
      {numVal == null ? "" : numVal}
    </span>
  );
}
