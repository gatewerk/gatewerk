/**
 * The declared control groups, minus the two that are their own sections.
 *
 * Six groups ship (`surface-tiers/templates.ts`, TEMPLATE_EDITOR_GROUP_BUDGET):
 * identity, fields, actions, timeout, external-links, instructions. `fields`
 * and `actions` render as their own sections below; the other four are here.
 *
 * Nothing roadmap tier is drawn. The two places that would be tempting:
 *   * auto_approve — not a control, but it silences the timeout group, so the
 *     group says so rather than accepting edits it will not save (see below).
 *   * changes_timeout_hours, allow_monitoring, default_auth_level,
 *     default_expiry_seconds — held, and preserved through the save.
 */
import type { EditorState } from "@gatewerk/web-core/state/templates/detail/draft-config-state";
import { PRIORITY_TOGGLE_TABS, priorityBucket } from "@gatewerk/web-core/state/templates/detail/priority-toggle";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { ROW_CONTENT_HEIGHT } from "~/screens/settings/_shared/ui";
import { INSET_INPUT_CLASS, INSET_STYLE, INSET_TEXTAREA_CLASS, RowLabel, SectionHeader, SelectMenu, Toggle } from "../_ui";

const TIMEOUT_PRESETS = [
  { value: "3600", label: "1 hour" },
  { value: "21600", label: "6 hours" },
  { value: "86400", label: "24 hours" },
  { value: "172800", label: "48 hours" },
  { value: "604800", label: "7 days" },
];

const TIMEOUT_ACTIONS = [
  { value: "expire", label: "Expire" },
  { value: "auto_approve", label: "Approve" },
  { value: "auto_reject", label: "Reject" },
];

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface Props {
  state: EditorState;
  patch: (next: Partial<EditorState>) => void;
  slugEditable: boolean;
  autoSlug: boolean;
  setAutoSlug: (v: boolean) => void;
}

export function EditConfig({ state, patch, slugEditable, autoSlug, setAutoSlug }: Props) {
  const timeoutOn = !!state.timeoutSeconds;
  // A timeout preset the operator set over the API may not be one of the five
  // offered. Showing it rather than snapping to the nearest preset keeps the
  // control honest; picking a preset then overwrites it.
  const timeoutOptions = TIMEOUT_PRESETS.some((p) => p.value === state.timeoutSeconds)
    ? TIMEOUT_PRESETS
    : [...TIMEOUT_PRESETS, { value: state.timeoutSeconds, label: `${state.timeoutSeconds} seconds` }];

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader label="Configuration" />

      {/* No card, matching ReadConfig — a card on this screen means "one item
          in a list", and these are one record's properties. ReadConfig draws
          all six fields as one flat list, one uniform gap, no interior line.
          This used to draw hairlines between the four declared groups
          instead, but three of those groups are a single row (Decide within,
          Review links, Instructions) — a hairline fenced each one off like a
          section, while the one multi-row group (Name/Slug/Description/
          Priority) got no divider between its own rows at all. Inconsistent,
          and it made edit read busier than the read-only view of the same
          data for no reason tied to the content. Same flat list here now,
          matching ReadConfig's value exactly — gap-7 (28px), not gap-3.5: the
          app's other row-based settings list (SettingsRow, settings/_shared/
          ui.tsx) spaces its rows 28px apart (py-3.5 on both sides of the
          hairline it draws), so 28 is the standard for "a list of editable
          rows" here, not a number picked to match this one screen alone. */}
      <div className="flex flex-col gap-7">
        {/* ── identity ── */}
        <div className="flex items-center gap-[22px]">
          <RowLabel>Name</RowLabel>
          <input
            value={state.name}
            onChange={(e) => {
              patch({ name: e.target.value, ...(autoSlug ? { slug: slugify(e.target.value) } : {}) });
            }}
            placeholder="Template name"
            aria-label="Template name"
            className={`${INSET_INPUT_CLASS} flex-1`}
            style={INSET_STYLE}
          />
        </div>

        <div className="flex items-center gap-[22px]">
          <RowLabel>Slug</RowLabel>
          {slugEditable ? (
            <input
              value={state.slug}
              onChange={(e) => {
                setAutoSlug(false);
                patch({ slug: slugify(e.target.value) });
              }}
              placeholder="template-slug"
              aria-label="Template slug"
              className={`${INSET_INPUT_CLASS} flex-1 font-mono text-[11px]`}
              style={INSET_STYLE}
            />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate font-mono text-[12px]" style={{ color: "var(--gw-t5)" }}>
                {state.slug}
              </span>
              <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
                Fixed once published. Agents call this template by its slug, and renaming it would
                strip custom actions from reviews already in flight.
              </span>
            </div>
          )}
        </div>

        <div className="flex items-start gap-[22px]">
          <RowLabel top>What this template is for</RowLabel>
          <AutoGrowTextarea
            value={state.description}
            onChange={(e) => patch({ description: e.target.value })}
            rows={2}
            placeholder="A note for whoever maintains this template"
            aria-label="What this template is for"
            className={`${INSET_TEXTAREA_CLASS} flex-1`}
            style={INSET_STYLE}
          />
        </div>

        <div className="flex items-center gap-[22px]">
          <RowLabel>Default priority</RowLabel>
          {/* Normal/High only. An existing Low or Critical default buckets
              into its nearer neighbour for display and writes back as
              normal/high on the next save — reversing the prior four-option picker.
              Capped width, same convention as the API key form's preset
              picker (ApiKeyForm.tsx) — without it SegmentedTabs' own
              `flex-1` stretches two short words across the whole pane,
              reading as a list-filter bar rather than a two-way toggle.
              `size="lg"`: the list-header default reads as undersized
              next to this row's full-height inputs. */}
          <div className="flex max-w-[260px]">
            <SegmentedTabs
              tabs={PRIORITY_TOGGLE_TABS}
              active={priorityBucket(state.priority)}
              onChange={(v) => patch({ priority: v })}
              ariaLabel="Default priority"
              size="lg"
              equalWidth
            />
          </div>
        </div>

        {/* ── timeout ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-[22px]">
            <RowLabel>Decide within</RowLabel>
            {/* `minHeight: ROW_CONTENT_HEIGHT` — same fix and same constant
                as SettingsRow's inline-edit swap (settings/_shared/ui.tsx):
                the Toggle alone is 20px tall, but the SelectMenu pair that
                appears on toggle-on is 28px, so without a floor the row grew
                by 8px the moment `timeoutOn` flipped and shoved every row
                below it down, then back up on toggle-off. */}
            <div className="flex flex-wrap items-center gap-3" style={{ minHeight: ROW_CONTENT_HEIGHT }}>
              <Toggle
                checked={timeoutOn}
                disabled={state.autoApprove}
                label="Time limit on a decision"
                onChange={() => patch({ timeoutSeconds: timeoutOn ? "" : "86400" })}
              />
              {timeoutOn && (
                <>
                  <SelectMenu
                    value={state.timeoutSeconds}
                    options={timeoutOptions}
                    onChange={(v) => patch({ timeoutSeconds: v })}
                    disabled={state.autoApprove}
                    ariaLabel="Time limit"
                    minWidth={104}
                  />
                  <span className="text-[11px]" style={{ color: "var(--gw-t8)" }}>
                    then
                  </span>
                  <SelectMenu
                    value={state.timeoutAction}
                    options={TIMEOUT_ACTIONS}
                    onChange={(v) => patch({ timeoutAction: v })}
                    disabled={state.autoApprove}
                    ariaLabel="What happens at the time limit"
                    minWidth={104}
                  />
                </>
              )}
            </div>
          </div>
          {state.autoApprove && (
            /* auto_approve is roadmap tier and has no control here, but it
               decides the review at creation, so the timeout never runs. Saying
               so beats letting an operator set a limit that silently does
               nothing — and `buildDraftConfig` would not persist it either. */
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--gw-amber-t)" }}>
              This template approves without a human, set over the API, so no decision time limit applies.
            </p>
          )}
        </div>

        {/* ── external-links ── */}
        <div className="flex items-center gap-[22px]">
          <RowLabel>Review links</RowLabel>
          <div className="flex items-center gap-3">
            <Toggle
              checked={state.enableReviewLinks}
              label="Allow shareable review links"
              onChange={() => patch({ enableReviewLinks: !state.enableReviewLinks })}
            />
            <span className="text-[11px]" style={{ color: "var(--gw-t8)" }}>
              Let a reviewer outside the project open one of these reviews by link
            </span>
          </div>
        </div>

        {/* ── instructions ── */}
        <div className="flex items-start gap-[22px]">
          <RowLabel top>Instructions for the reviewer</RowLabel>
          <AutoGrowTextarea
            value={state.instructions}
            onChange={(e) => patch({ instructions: e.target.value })}
            rows={3}
            placeholder="What the reviewer should check before deciding"
            aria-label="Instructions for the reviewer"
            className={`${INSET_TEXTAREA_CLASS} flex-1`}
            style={INSET_STYLE}
          />
        </div>
      </div>
    </section>
  );
}
