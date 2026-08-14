import { AutoGrowTextarea } from "../../../../components/AutoGrowTextarea";
import { useInlineEdit } from "../use-inline-edit";

interface Props {
  value: unknown;
  editable: boolean;
  onCommit: (v: string) => void;
}

export function TextField({ value, editable, onCommit }: Props) {
  const strVal = typeof value === "string" ? value : value == null ? "" : String(value);

  const { editing, draft, startEdit, updateDraft, handleKeyDown, handleBlur } = useInlineEdit(
    onCommit,
  );

  if (!editable || !editing) {
    return (
      <div
        className="min-h-[22px] cursor-text rounded-[6px] text-[13.5px] text-t4 transition-colors"
        style={{ padding: "2px 4px" }}
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
      </div>
    );
  }

  return (
    <AutoGrowTextarea
      autoFocus
      rows={1}
      value={draft}
      onChange={(e) => updateDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="w-full rounded-[6px] bg-transparent text-[13.5px] text-t2 outline-none"
      style={{
        padding: "2px 4px",
        background: "rgba(var(--gw-line-rgb),.04)",
        border: "none",
        boxShadow: "none",
        fontFamily: "inherit",
      }}
    />
  );
}
