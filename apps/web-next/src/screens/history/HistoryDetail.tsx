/**
 * HistoryDetail — the resolved record. Read only, by definition: a decided
 * review is a record, not a form.
 *
 * Design: DetailHistory.dc.html. No decision rail, no
 * hero summary card — the outcome is carried by the Details rail and the
 * inline diff on the fields that changed. The one action a resolved record
 * keeps is the header's "..." menu — export or archive (HistoryDetailMenu.tsx).
 * No Delete: this is the audit trail, and a
 * decided review is hidden via Archive, never permanently destroyed.
 *
 * The `payload -> edited_payload` diff renders inline on the changed field
 * rather than as a separate "what changed" block, matching the design and the
 * inbox's "just the line" staging. Two of the design's treatments are built:
 * a short scalar shows the new value on an amber-tinted row with a compact
 * `was <old>` line beneath, and a long text value collapses the old one behind
 * a <details> disclosure, because a strikethrough over a paragraph is
 * unreadable. The typed image and json treatments are not built; they fall back
 * to the disclosure.
 *
 * Not built: the rail's Record section (export /
 * archive / delete). The rail is Details only.
 */

import { X, Check, RotateCw } from "lucide-react";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle, timeAgo } from "@gatewerk/web-core/lib/utils";
import { ActorRow } from "~/components/ActorRow";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { resolveFields, type FieldDescriptor } from "~/screens/inbox/detail/payload-fields";
import { FieldValue } from "~/screens/inbox/detail/FieldValue";
import { ActivityTimeline } from "./ActivityTimeline";
import { HistoryDetailMenu } from "./HistoryDetailMenu";
import { decisionRole, isUndecided, type DecisionRole } from "./history-model";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";

/** Roughly where a strikethrough stops being readable. Design README: ~120 chars. */
const LONG_VALUE_CHARS = 120;

/** rgb triplet + text token per decision role, for the rail's tonal disc. */
const ROLE_TONE: Record<DecisionRole, { rgb: string; text: string; aria: string }> = {
  affirmative: {
    rgb: "var(--gw-green-rgb)",
    text: "var(--gw-green-d)",
    aria: "Affirmative decision",
  },
  destructive: {
    rgb: "var(--gw-red-rgb)",
    text: "var(--gw-red-t)",
    aria: "Destructive decision",
  },
  neutral: { rgb: "var(--gw-blue-rgb)", text: "var(--gw-blue-t)", aria: "Neutral decision" },
};

const ROLE_GLYPH: Record<DecisionRole, typeof Check> = {
  affirmative: Check,
  destructive: X,
  neutral: RotateCw,
};

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function isLong(text: string): boolean {
  return text.length > LONG_VALUE_CHARS || text.includes("\n");
}

/**
 * The rail prints bare `YYYY-MM-DD`. A record's date is a fact to be read at a
 * glance and compared against the row above it, not a sentence — and it is the
 * local calendar day, matching the day the list buckets the row under.
 */
function isoDay(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function HistoryDetail({ review }: { review: Review }) {
  // On a phone the two body columns (fields, details rail) stack into one
  // scrolling column instead of sitting side by side. The rail's own width
  // is a fixed 314px with shrink-0 (see below), which on a narrow viewport
  // would refuse to shrink and leave the fields column a sliver — the exact
  // min-width trap this plan calls out. Stacking removes the constraint
  // instead of fighting it with a second breakpoint.
  const narrow = useNarrowViewport();
  // resolveFields enumerates the ORIGINAL payload's keys. A key that exists
  // only in edited_payload would therefore never render, and the record would
  // omit it while presenting itself as a complete account of what changed.
  // Unreachable through the Inbox editor, which only edits template-declared
  // fields already present in the payload — but if an editor ever gains
  // add-a-field, this call site is what has to change, not the diff below.
  const fields = resolveFields(review);
  const original = review.payload ?? {};
  const edited = review.edited_payload ?? null;
  const role = decisionRole(review.decision);
  const tone = ROLE_TONE[role];
  const Glyph = ROLE_GLYPH[role];
  // Raw, not humanised: ActorRow decides what this value IS (email, id, or a
  // plain name) and humanises only the email. Pre-flattening it here would
  // strip the "@" that is the only evidence a person decided this.
  const decider = review.decided_by ?? "System";

  // A lapsed review was never decided — the server leaves
  // `decision`/`decided_at`/`decided_by` null (timeout-worker.ts expire path).
  // Without this branch the rail would read Decision "unknown", the breadcrumb
  // would claim "decided", and the avatar row would credit "System".
  //
  // Derived from the data, not from `status`: archiving a lapsed review moves
  // it to "archived" without filling any of those columns in.
  const isLapse = isUndecided(review);

  // The template's own button word when the projection carries it ("Publish"),
  // falling back to the raw decision for records decided before configurable
  // actions existed (manifest §Data adaptations 3).
  const decisionLabel = isLapse
    ? "expired"
    : (review.action_label ?? review.decision ?? "unknown").replace(/_/g, " ");

  // Shared between the desktop two column body and the phone's stacked one,
  // so the two layouts render the exact same content and only their
  // container changes.
  const fieldsSection = (
    <section>
      <div className="flex flex-col" style={{ gap: 5 }}>
        {fields.map((field) => (
          <SubmissionRow
            // Scoped to the record: two records on the same template share
            // field names, and a bare field.name key lets React reuse the
            // row's uncontrolled <details>, carrying an open disclosure from
            // one record onto the next.
            key={`${review.id}:${field.name}`}
            field={field}
            original={original}
            edited={edited}
          />
        ))}
      </div>
    </section>
  );

  const detailsRail = (
    <section>
      <RulerTickHeader label="Details" marginClassName="mb-[15px]" endTick={false} />
      <div className="flex flex-col" style={{ gap: 14 }}>
        {/* No decider exists on a lapsed review — crediting "System" with a
            decision nobody made would be false. */}
        {!isLapse && (
          <ActorRow
            value={decider}
            role="decided by"
            // Strict false only. Null is "no claim" — records decided before
            // the API carried this field — and calling those unverified
            // would invent a fact about them.
            note={review.decided_by_verified === false ? "unverified" : undefined}
          />
        )}

        <RailRow label="Decision">
          <span className="inline-flex items-center" style={{ gap: 7 }}>
            <span
              aria-label={tone.aria}
              role="img"
              className="inline-flex shrink-0 items-center justify-center"
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: `rgba(${tone.rgb},.13)`,
              }}
            >
              <Glyph size={12} strokeWidth={2.6} style={{ color: tone.text }} />
            </span>
            <span
              className="font-mono uppercase"
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".08em",
                color: tone.text,
              }}
            >
              {decisionLabel}
            </span>
          </span>
        </RailRow>

        <RailRow label="Template">
          <RailValue color="var(--gw-t5)">{review.template_slug}</RailValue>
        </RailRow>
        <RailRow label="Version">
          <RailValue>v{review.current_version}</RailValue>
        </RailRow>
        <RailRow label="Created">
          <RailValue>{isoDay(review.created_at)}</RailValue>
        </RailRow>
        <RailRow label="Decided">
          <RailValue>{review.decided_at ? isoDay(review.decided_at) : "not decided"}</RailValue>
        </RailRow>
        {/* Omitted rather than shown empty: most reviews have no callback,
            and a blank row reads as a missing value, not an absent one. */}
        {review.callback_url && (
          <RailRow label="Callback" gap={12}>
            <span
              className="min-w-0 truncate font-mono"
              style={{ fontSize: 11.5, color: "var(--gw-t6)" }}
            >
              {review.callback_url}
            </span>
          </RailRow>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* ── Header ── context, plus the one action a resolved record still
          has: the "..." menu (export / archive). No decision actions —
          it is already decided. Fixed, so the two body columns scroll
          under it independently. */}
      <div
        className="shrink-0"
        style={{
          padding: "20px 30px 16px",
          borderBottom: "1px solid rgba(var(--gw-line-rgb),.07)",
        }}
      >
        <div className="flex items-center" style={{ gap: 13 }}>
          {/* Same derivation the list row uses. Reading payload.title directly
              made a record whose payload has no `title` (an email-review carries
              To/Subject/Body) show its raw id in the header while the row beside
              it read "Intro". */}
          <h1
            className="min-w-0 flex-1 truncate font-display"
            style={{
              margin: 0,
              fontSize: 23,
              fontWeight: 600,
              letterSpacing: "-0.015em",
              color: "var(--gw-t1)",
            }}
          >
            {getReviewTitle(original, review.id)}
          </h1>
          <HistoryDetailMenu review={review} />
        </div>
        {/* Same breadcrumb grammar as Inbox's DetailHeader.tsx and Templates'
            DetailHeader.tsx: a dedicated "/" span, dimmer than the text
            around it, not space alone. */}
        <div
          className="flex items-center font-mono"
          style={{ gap: 9, marginTop: 10, fontSize: 11.5, color: "var(--gw-t8)" }}
        >
          <span className="min-w-0 truncate">{review.template_slug}</span>
          <span className="shrink-0" style={{ color: "var(--gw-t11)" }}>/</span>
          {/* "expired" is still the right word for a lapse the reader is
              looking at, archived or not: it names what happened to the
              record, and archiving is not a second thing that happened to it. */}
          <span className="shrink-0">
            {isLapse ? "expired" : "decided"} {timeAgo(review.decided_at ?? review.created_at)}
          </span>
          <span className="shrink-0" style={{ color: "var(--gw-t11)" }}>/</span>
          <span className="shrink-0">v{review.current_version}</span>
        </div>
      </div>

      {/* ── Body ── two columns on a laptop, each with its own scroll; one
          stacked, single scrolling column on a phone (see `narrow` above). */}
      {narrow ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex min-w-0 flex-col" style={{ padding: "20px 16px", gap: 32 }}>
            {fieldsSection}
            <ActivityTimeline review={review} />
          </div>

          {/* Same "Details" content as the desktop rail, stacked below the
              fields instead of beside them, top border instead of left. */}
          <div
            className="flex min-w-0 flex-col"
            style={{
              borderTop: "1px solid rgba(var(--gw-line-rgb),.07)",
              padding: "20px 16px",
              gap: 26,
            }}
          >
            {detailsRail}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-w-0 flex-1 flex-col overflow-y-auto"
            style={{ padding: "24px 30px", gap: 32 }}
          >
            {fieldsSection}
            <ActivityTimeline review={review} />
          </div>

          {/* ── Details rail ── record metadata. Feedback is deliberately not
              here; it belongs to the moment someone said it, so it lives in
              Activity. */}
          <aside
            className="flex shrink-0 flex-col overflow-y-auto"
            style={{
              width: 314,
              borderLeft: "1px solid rgba(var(--gw-line-rgb),.07)",
              padding: "24px 22px",
              gap: 26,
            }}
          >
            {detailsRail}
          </aside>
        </div>
      )}
    </div>
  );
}


function RailRow({
  label,
  gap,
  children,
}: {
  label: string;
  gap?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between" style={{ gap }}>
      <span className="shrink-0" style={{ fontSize: 12, color: "var(--gw-t8)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function RailValue({
  color = "var(--gw-t4)",
  children,
}: {
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="min-w-0 truncate font-mono" style={{ fontSize: 12, color }}>
      {children}
    </span>
  );
}

/**
 * One payload field as the record shows it. The label dims when the value is
 * untouched and brightens when it changed, so the eye finds the edits without
 * reading a word. t9/t7 measured under 4.5:1 against the page background —
 * legible-in-isolation but not comfortably so, and this is content a
 * reviewer is reading to understand what happened, not passive chrome.
 * Bumped a tier each (t9→t7, t8→t6) so the quiet/unchanged floor still
 * clears contrast; the changed/unchanged order is unchanged.
 */
function SubmissionRow({
  field,
  original,
  edited,
}: {
  field: FieldDescriptor;
  original: Record<string, unknown>;
  edited: Record<string, unknown> | null;
}) {
  const oldValue = original[field.name];
  const newValue = edited ? edited[field.name] : undefined;
  const changed =
    edited !== null &&
    Object.prototype.hasOwnProperty.call(edited, field.name) &&
    asText(newValue) !== asText(oldValue);

  const shown = changed ? newValue : oldValue;
  const multiline = isLong(asText(shown));

  return (
    <div
      className="flex items-start rounded-[8px]"
      style={{
        gap: 24,
        padding: "6px 10px",
        margin: "0 -10px",
        background: changed ? "rgba(var(--gw-amber-rgb),.05)" : undefined,
      }}
    >
      {/* Labels are top aligned so an expanded diff grows downward without
          shifting the key. A wrapping value needs the extra pixel to sit on
          the first line's baseline. */}
      <div
        className="shrink-0 font-mono"
        style={{
          width: 142,
          paddingTop: multiline ? 2 : 1,
          fontSize: 12.5,
          color: changed ? "var(--gw-t6)" : "var(--gw-t7)",
        }}
      >
        {field.label}
      </div>

      <div
        className="flex min-w-0 flex-1 flex-col"
        style={{ gap: changed ? (multiline ? 8 : 4) : 0 }}
      >
        <RecordValue field={field} value={shown} changed={changed} />
        {changed && <WasLine oldValue={oldValue} />}
      </div>
    </div>
  );
}

/**
 * Text, markdown and number render here rather than through FieldValue because
 * the inbox's read-only renderers pin their own colour, and this screen's
 * unchanged/changed split (t4 vs t3) IS the signal that says which value is
 * live. Every other type keeps its inbox renderer: the design shows none of
 * them, and trading away an image or json treatment to win a colour would be a
 * bad deal.
 *
 * Unchanged sits at t4 — the exact color the inbox's own field values use
 * (FieldRow.tsx's FieldValue) — History's record
 * should read as legibly as the inbox does, full stop. The diff signal
 * still stands on the amber background tint and the "was" disclosure, not
 * on text color alone, so parity here doesn't cost that.
 */
function RecordValue({
  field,
  value,
  changed,
}: {
  field: FieldDescriptor;
  value: unknown;
  changed: boolean;
}) {
  const color = changed ? "var(--gw-t3)" : "var(--gw-t4)";

  if (field.type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return (
      <span
        className="tabular-nums"
        style={{ fontSize: 13.5, color, fontVariantNumeric: "tabular-nums" }}
      >
        {Number.isFinite(n) && value !== null && value !== "" && value !== undefined
          ? n.toLocaleString("en-US")
          : asText(value)}
      </span>
    );
  }

  if (field.type === "text" || field.type === "markdown") {
    return (
      <div
        className="whitespace-pre-wrap break-words"
        style={{ fontSize: 13.5, lineHeight: 1.62, color }}
      >
        {asText(value)}
      </div>
    );
  }

  return (
    <FieldValue
      type={field.type}
      value={value}
      editable={false}
      options={field.options}
      onCommit={() => {}}
    />
  );
}

/**
 * The previous value of a changed field, behind one click.
 *
 * This used to branch on length: short values struck through inline and were
 * always on screen, long ones collapsed. That put two grammars in one list and
 * let an arbitrary threshold decide which one a reader got — a field crossing
 * 120 characters changed how its history was told. Every field now reveals the
 * same way, which is also what the silence rule
 * asks for: the current value is the hero and the old value speaks when asked.
 */
function WasLine({ oldValue }: { oldValue: unknown }) {
  const text = asText(oldValue);

  return (
    <details className="group">
      <summary
        className="flex w-fit cursor-pointer list-none items-center [&::-webkit-details-marker]:hidden"
        style={{ gap: 6, padding: "1px 0", color: "var(--gw-t7)" }}
      >
        <svg
          className="shrink-0 transition-transform duration-150 group-open:rotate-90"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          aria-hidden
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: ".06em" }}>
          <span className="group-open:hidden">was · show previous</span>
          <span className="hidden group-open:inline">was · previous version</span>
        </span>
      </summary>
      <div
        className="whitespace-pre-wrap break-words"
        style={{
          marginTop: 8,
          borderLeft: "2px solid rgba(var(--gw-red-rgb),.38)",
          padding: "2px 0 2px 12px",
          fontSize: 12.5,
          lineHeight: 1.6,
          color: "var(--gw-t7)",
        }}
      >
        {/* A field cleared to nothing still changed, and an empty disclosure
            would read as a broken control rather than an emptied field. */}
        {text || "empty"}
      </div>
    </details>
  );
}
