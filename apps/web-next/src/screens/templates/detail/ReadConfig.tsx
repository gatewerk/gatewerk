/**
 * Read mode's configuration block: the same declared axes as EditConfig, stated
 * rather than editable.
 *
 * The prototype put this in the right rail. It moves into the main column here
 * because `instructions` is free text that a rail 316px wide cannot show
 * without wrapping into a column of two-word lines, and instructions are the
 * only reviewer-facing copy the product has.
 */
import type { TemplateSchema } from "@gatewerk/shared";
import type { EditorState } from "@gatewerk/web-core/state/templates/detail/draft-config-state";
import { RowLabel, SectionHeader } from "../_ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start" style={{ gap: 22 }}>
      <RowLabel top>{label}</RowLabel>
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed" style={{ color: "var(--gw-t4)" }}>
        {children}
      </div>
    </div>
  );
}

/** Permanent nulls get a semantic word, never a dash. */
function NotSet() {
  return <span style={{ color: "var(--gw-t7)" }}>Not set</span>;
}

function formatSeconds(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw;
  if (n % 86400 === 0) {
    const d = n / 86400;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  if (n % 3600 === 0) {
    const h = n / 3600;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const m = Math.round(n / 60);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}

const TIMEOUT_ACTION_WORDS: Record<string, string> = {
  expire: "it expires",
  auto_approve: "it is approved",
  auto_reject: "it is rejected",
};

export function ReadConfig({ template, state }: { template: TemplateSchema; state: EditorState }) {
  const timeout = state.timeoutSeconds
    ? `${formatSeconds(state.timeoutSeconds)}, then ${TIMEOUT_ACTION_WORDS[state.timeoutAction] ?? state.timeoutAction}`
    : null;

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader label="Configuration" />
      {/* No card. On this screen a card means "one item in a list" — a field,
          an action, a chain step. These are one record's properties, and both
          swept screens draw that flat on the pane: the inbox's payload block
          and History's Submission. A container around them made Configuration
          look like a fourth list. gap-7 (28px), matching EditConfig and the
          app's other row-based settings list (SettingsRow, settings/_shared/
          ui.tsx spaces rows 28px apart) — not a number picked for this screen
          alone. */}
      <div className="flex flex-col gap-7">
        <Row label="What this template is for">{template.description || <NotSet />}</Row>
        <Row label="Default priority">
          {state.priority.charAt(0).toUpperCase() + state.priority.slice(1)}
        </Row>
        <Row label="Decide within">{timeout ?? <span style={{ color: "var(--gw-t7)" }}>No time limit</span>}</Row>
        <Row label="Review links">
          {state.enableReviewLinks ? "Shareable with a reviewer outside the project" : "Project members only"}
        </Row>
        <Row label="Instructions for the reviewer">{template.instructions || <NotSet />}</Row>
      </div>
    </section>
  );
}
