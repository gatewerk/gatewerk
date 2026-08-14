import { Calendar } from "lucide-react";

interface Props {
  value: unknown;
}

function formatDate(val: unknown): string {
  if (!val) return "";
  try {
    return new Date(String(val)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return String(val);
  }
}

export function DateField({ value }: Props) {
  const formatted = formatDate(value);

  if (!formatted) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-[7px] font-mono text-[13px]" style={{ color: "var(--gw-t4)" }}>
      <Calendar size={12} style={{ color: "var(--gw-t8)", flexShrink: 0 }} />
      {formatted}
    </span>
  );
}
