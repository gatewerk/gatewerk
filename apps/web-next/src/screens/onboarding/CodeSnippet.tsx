/**
 * The three-language snippet the activation flow hands the integrator. Shared
 * by the cloud wizard's step 2 and the OSS first-run empty state, which the
 * handoff calls "the same content, presented inline instead of in a modal".
 *
 * The snippets are NOT ported from apps/web. Its version could not have worked:
 * it POSTed `{title, description, priority:"medium"}`, but ReviewCreateBodySchema
 * requires `template` and `payload` and PRIORITIES has no "medium"
 * (packages/shared/src/enums.ts:1), so every request 422s — and the wizard's
 * poll then waits forever on a review that could never arrive. It also named a
 * package (`@gatewerk/sdk-ts`) and a constructor (`new GatewerkClient`) that do
 * not exist; the published SDKs are `gatewerk` with a `createClient` factory.
 * These are rewritten against the schema and README's canonical examples.
 *
 * `base` is `window.location.origin` because nginx proxies `/api/` to the API
 * container (docker/nginx.conf:44), so the app's own origin is a working API
 * base in cloud, in the quickstart compose, and in local dev alike.
 *
 * The styling is likewise not ported — apps/web's Tailwind classes
 * (`bg-background`, `text-dim`, `ring-border`) have no generated CSS in
 * web-next, so this uses inline styles over the `--gw-*` custom properties, the
 * pattern `screens/templates/_ui.tsx` and `auth/controls.tsx` already follow.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

type Lang = "curl" | "typescript" | "python";

const TABS: { id: Lang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
];

interface Props {
  apiKey: string;
  /** A slug that actually exists in this project. `reviews.create` rejects an unknown one. */
  templateSlug: string;
}

export function CodeSnippet({ apiKey, templateSlug }: Props) {
  const [lang, setLang] = useState<Lang>("curl");
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const key = apiKey || "YOUR_API_KEY";
  const slug = templateSlug || "YOUR_TEMPLATE";
  const base = typeof window !== "undefined" ? window.location.origin : "https://app.gatewerk.com";

  const snippets: Record<Lang, string> = {
    curl: `curl -X POST ${base}/api/v1/reviews \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "template": "${slug}",
    "payload": {
      "summary": "Refund 180 to a test customer",
      "detail": "Duplicate charge on order 88231."
    },
    "priority": "normal"
  }'`,
    typescript: `import { createClient } from "gatewerk";

const gw = createClient({
  apiKey: "${key}",
  url: "${base}",
});

await gw.reviews.create({
  template: "${slug}",
  payload: {
    summary: "Refund 180 to a test customer",
    detail: "Duplicate charge on order 88231.",
  },
  priority: "normal",
});`,
    python: `from gatewerk import create_client

gw = create_client(api_key="${key}", url="${base}")

gw.reviews.create(
    template="${slug}",
    payload={
        "summary": "Refund 180 to a test customer",
        "detail": "Duplicate charge on order 88231.",
    },
    priority="normal",
)`,
  };

  function copySnippet() {
    navigator.clipboard.writeText(snippets[lang]).then(
      () => {
        setCopied(true);
        toast.success("Snippet copied");
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        toast.error("Failed to copy");
      },
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: 3,
            borderRadius: 9,
            background: "var(--gw-inset)",
          }}
        >
          {TABS.map((t) => {
            const active = lang === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setLang(t.id)}
                className="gw-focus-ring"
                style={{
                  border: "none",
                  cursor: "pointer",
                  borderRadius: 7,
                  padding: "5px 11px",
                  fontSize: 11,
                  fontWeight: 500,
                  transition: "background-color .12s, color .12s",
                  background: active ? "var(--gw-panel-a)" : "transparent",
                  color: active ? "var(--gw-t2)" : "var(--gw-t7)",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={copySnippet}
          className="gw-focus-ring"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            border: "none",
            cursor: "pointer",
            borderRadius: 7,
            padding: "5px 10px",
            fontSize: 11,
            fontWeight: 500,
            background: "transparent",
            color: copied ? "var(--gw-green-t)" : "var(--gw-t7)",
          }}
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.9} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          overflowX: "auto",
          borderRadius: 11,
          padding: 14,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.6,
          color: "var(--gw-t4)",
          background: "var(--gw-inset)",
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
        }}
      >
        {snippets[lang]}
      </pre>
    </div>
  );
}
