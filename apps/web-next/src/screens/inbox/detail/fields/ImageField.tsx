import { ImageIcon } from "lucide-react";

interface Props {
  value: unknown;
}

export function ImageField({ value }: Props) {
  // Value is a filename or URL string (no raster fetch per spec)
  const filename = typeof value === "string" ? value : value == null ? "" : String(value);
  const basename = filename.split("/").pop() ?? filename;

  return (
    <div className="flex items-center" style={{ gap: 11 }}>
      <div
        className="flex items-center justify-center rounded-[7px]"
        style={{
          width: 52,
          height: 38,
          background: "var(--gw-image-tile)",
          border: "1px solid rgba(var(--gw-line-rgb),.12)",
          flexShrink: 0,
        }}
      >
        <ImageIcon size={16} style={{ color: "var(--gw-image-ink)" }} />
      </div>
      <span className="font-mono text-[12px]" style={{ color: "var(--gw-t6)" }}>
        {basename || "image"}
      </span>
    </div>
  );
}
