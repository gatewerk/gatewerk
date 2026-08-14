/**
 * ReviewPayloadBox — the recipient's read-only view of the review payload.
 *
 * Spec §4b. Design: Gatewerk External Review.dc.html:78-87. Unlike the inbox
 * (fields grouped by whitespace, no dividers) this surface DOES draw a hairline
 * between fields; the trailing one after the last field is suppressed (spec Q6).
 *
 * Read-only by construction: no pencil / lock affordance, no inline edit, and
 * `edited_payload` is never produced here.
 *
 * Inset surfaces use the theme's inset tokens rather than the prototype's raw
 * `rgba(0,0,0,·)` scrims: black alpha reads as flat gray on the cream light
 * theme. `--gw-inset-soft` (box) under `--gw-inset` (blocks) keeps the design's
 * nesting order in both themes.
 */

import { assertNever, type FieldType } from "@gatewerk/shared";
import type { FieldDescriptor } from "~/screens/inbox/detail/payload-fields";
import { safeUrl } from "~/lib/safe-url";
import { formatDecidedDate } from "./recipient-state";

// ── value primitives (only three shapes exist in the design) ─────────────────

function Plain({
  children,
  tabular,
}: {
  children: React.ReactNode;
  tabular?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 13.5,
        lineHeight: 1.5,
        color: "var(--gw-t3)",
        fontVariantNumeric: tabular ? "tabular-nums" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function Block({ children }: { children: React.ReactNode }) {
  return (
    <pre
      className="font-mono"
      style={{
        margin: 0,
        fontSize: 12,
        lineHeight: 1.55,
        color: "var(--gw-t5)",
        background: "var(--gw-inset)",
        border: "1px solid rgba(var(--gw-line-rgb),.07)",
        borderRadius: 9,
        padding: "11px 13px",
        whiteSpace: "pre-wrap",
        overflowX: "auto",
      }}
    >
      {children}
    </pre>
  );
}

function BoolPill({ on }: { on: boolean }) {
  return (
    <span
      className="inline-flex items-center"
      style={{
        fontSize: 12.5,
        fontWeight: 500,
        borderRadius: 999,
        padding: "3px 12px",
        color: on ? "var(--gw-green-d)" : "var(--gw-t6)",
        background: on
          ? "rgba(var(--gw-green-rgb),.14)"
          : "rgba(var(--gw-line-rgb),.06)",
      }}
    >
      {on ? "Enabled" : "Disabled"}
    </span>
  );
}

function MediaBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 9,
        border: "1px solid rgba(var(--gw-line-rgb),.07)",
        background: "var(--gw-inset)",
        overflow: "hidden",
        display: "inline-flex",
        maxWidth: "100%",
      }}
    >
      {children}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function asJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

// ── the exhaustive renderer ──────────────────────────────────────────────────

/**
 * Exhaustive switch over all 11 FieldTypes with an assertNever default
 * (locked rule: feedback_assertnever_discriminated_union_renderers).
 * text / markdown / boolean come from the design; the other eight reuse the
 * same three primitives (spec §4b table, Q13).
 */
export function RecipientFieldValue({
  type,
  value,
}: {
  type: FieldType;
  value: unknown;
}) {
  switch (type) {
    case "text":
    case "select":
    case "buttons":
      return <Plain>{asText(value)}</Plain>;

    case "number":
      return <Plain tabular>{asText(value)}</Plain>;

    case "date": {
      const formatted = formatDecidedDate(asText(value));
      return <Plain>{formatted ?? asText(value)}</Plain>;
    }

    case "url": {
      const href = safeUrl(value, "link");
      // Not an absolute http(s)/mailto URL: show the raw value, never link it.
      if (!href) return <Plain>{asText(value)}</Plain>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "var(--gw-blue-t)",
            textDecoration: "none",
            wordBreak: "break-all",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--gw-blue-h)";
            e.currentTarget.style.textDecoration = "underline";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--gw-blue-t)";
            e.currentTarget.style.textDecoration = "none";
          }}
        >
          {href}
        </a>
      );
    }

    case "markdown":
      // Raw text in a mono block — the design does not render markdown here.
      return <Block>{asText(value)}</Block>;

    case "json":
      return <Block>{asJson(value)}</Block>;

    case "boolean":
      return <BoolPill on={value === true} />;

    case "image": {
      const src = safeUrl(value, "media");
      if (!src) return <Plain>{asText(value)}</Plain>;
      return (
        <MediaBox>
          <img
            src={src}
            alt=""
            style={{ maxWidth: "100%", maxHeight: 320, objectFit: "contain" }}
          />
        </MediaBox>
      );
    }

    case "video": {
      const src = safeUrl(value, "media");
      if (!src) return <Plain>{asText(value)}</Plain>;
      return (
        <MediaBox>
          <video
            src={src}
            controls
            style={{ maxWidth: "100%", maxHeight: 320 }}
          />
        </MediaBox>
      );
    }

    default:
      return assertNever(type);
  }
}

// ── the box ──────────────────────────────────────────────────────────────────

export function ReviewPayloadBox({ fields }: { fields: FieldDescriptor[] }) {
  return (
    <div
      style={{
        border: "1px solid rgba(var(--gw-line-rgb),.09)",
        borderRadius: 14,
        background: "var(--gw-inset-soft)",
        padding: "4px 18px",
      }}
    >
      {fields.length === 0 && (
        <div style={{ padding: "14px 0", fontSize: 13, color: "var(--gw-t8)" }}>
          No payload attached to this review.
        </div>
      )}

      {fields.map((f, i) => (
        <div
          key={f.name}
          style={{
            padding: "14px 0",
            borderBottom:
              i === fields.length - 1
                ? undefined
                : "1px solid rgba(var(--gw-line-rgb),.06)",
          }}
        >
          <div
            className="font-mono uppercase"
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: ".14em",
              color: "var(--gw-t9)",
              marginBottom: 6,
            }}
          >
            {f.label}
          </div>
          <RecipientFieldValue type={f.type} value={f.value} />
        </div>
      ))}
    </div>
  );
}
