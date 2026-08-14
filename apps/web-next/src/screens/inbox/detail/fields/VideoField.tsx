import { Film } from "lucide-react";

interface Props {
  value: unknown;
}

export function VideoField({ value }: Props) {
  const filename = typeof value === "string" ? value : value == null ? "" : String(value);
  const basename = filename.split("/").pop() ?? filename;

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex items-center justify-center rounded-[6px]"
        style={{
          width: 36,
          height: 36,
          background: "rgba(var(--gw-line-rgb),.06)",
          border: "1px solid rgba(var(--gw-line-rgb),.10)",
          flexShrink: 0,
        }}
      >
        <Film size={16} style={{ color: "var(--gw-t8)" }} />
      </div>
      <span className="font-mono text-[12px]" style={{ color: "var(--gw-t6)" }}>
        {basename || "video"}
      </span>
    </div>
  );
}
