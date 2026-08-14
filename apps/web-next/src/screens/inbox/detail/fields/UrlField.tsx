import { ExternalLink } from "lucide-react";
import { safeUrl } from "~/lib/safe-url";

interface Props {
  value: unknown;
}

export function UrlField({ value }: Props) {
  const strVal = typeof value === "string" ? value : value == null ? "" : String(value);

  if (!strVal) {
    return null;
  }

  // Payload values are agent-authored and a template can declare any field as
  // `type:"url"`, so an unchecked href would run `javascript:` on click.
  const href = safeUrl(strVal, "link");
  if (!href) {
    return (
      <span className="break-all font-mono text-[12.5px] text-t5">{strVal}</span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-[6px] break-all font-mono text-[12.5px] transition-opacity hover:opacity-80"
      style={{ color: "var(--gw-blue-t)" }}
    >
      <ExternalLink size={12} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 1 }} />
      {strVal}
    </a>
  );
}
