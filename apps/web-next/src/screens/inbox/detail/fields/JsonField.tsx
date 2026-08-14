interface Props {
  value: unknown;
}

function prettyJson(val: unknown): string {
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

export function JsonField({ value }: Props) {
  if (value == null) {
    return null;
  }

  return (
    <pre
      className="overflow-x-auto rounded-[8px] font-mono text-[11.5px] leading-relaxed"
      style={{
        padding: "8px 12px",
        background: "rgba(var(--gw-line-rgb),.04)",
        border: "1px solid rgba(var(--gw-line-rgb),.08)",
        color: "var(--gw-t5)",
        margin: 0,
        maxHeight: 240,
        overflowY: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      }}
    >
      {prettyJson(value)}
    </pre>
  );
}
