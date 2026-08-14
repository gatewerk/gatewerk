/**
 * ButtonsField — chip group (single-select). Editable picks one.
 */
interface Props {
  value: unknown;
  editable: boolean;
  options?: string[];
  onCommit: (v: string) => void;
}

export function ButtonsField({ value, editable, options = [], onCommit }: Props) {
  const strVal = typeof value === "string" ? value : value == null ? "" : String(value);

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = opt === strVal;
        return (
          <button
            key={opt}
            type="button"
            disabled={!editable}
            onClick={() => editable && onCommit(opt)}
            className="rounded-[5px] px-2.5 py-0.5 font-mono text-[11.5px] font-medium transition-colors"
            style={{
              background: active
                ? "rgba(var(--gw-line-rgb),.14)"
                : "rgba(var(--gw-line-rgb),.05)",
              color: active ? "var(--gw-t2)" : "var(--gw-t7)",
              border: active
                ? "1px solid rgba(var(--gw-line-rgb),.18)"
                : "1px solid rgba(var(--gw-line-rgb),.08)",
              cursor: editable ? "pointer" : "default",
            }}
          >
            {opt}
          </button>
        );
      })}
      {options.length === 0 && (
        <span style={{ color: "var(--gw-t9)", fontSize: "13px" }}>
          {strVal}
        </span>
      )}
    </div>
  );
}
