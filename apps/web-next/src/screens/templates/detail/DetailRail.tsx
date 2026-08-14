/**
 * Right rail: what this template has done, and the buttons that change its
 * lifecycle. 316px, matching the inbox review rail.
 *
 * Read mode shows activity and the lifecycle buttons; edit mode shows the save
 * state and Publish / Discard. Activity is hidden while editing for the same
 * reason the prototype hides it: numbers about the published version are
 * misleading next to unsaved edits.
 */
import { Loader2 } from "lucide-react";
import type { TemplateSchema } from "@gatewerk/shared";
import type { EditorState } from "@gatewerk/web-core/state/templates/detail/draft-config-state";
import type { TemplateStats } from "@gatewerk/web-core/state/templates/detail/use-template-stats";
import { GhostButton, PrimaryButton, SectionHeader } from "../_ui";

function StatTile({ value, caption, accent = false }: { value: string; caption: string; accent?: boolean }) {
  return (
    <div
      className="flex-1 rounded-[10px] px-3.5 py-3"
      style={{ background: "var(--gw-panel-flat)", border: "1px solid rgba(var(--gw-line-rgb),.08)" }}
    >
      <div
        className="font-mono text-[19px] font-semibold tabular-nums leading-none"
        style={{ color: accent ? "var(--gw-green)" : "var(--gw-t1)" }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[11px]" style={{ color: "var(--gw-t7)" }}>
        {caption}
      </div>
    </div>
  );
}

interface Props {
  template: TemplateSchema;
  state: EditorState;
  stats: TemplateStats | null | undefined;
  isEditing: boolean;
  saving: boolean;
  canPublish: boolean;
  /**
   * Whether there is anything to publish: a draft template, a persisted
   * draft_config, or edits made this session that autosave hasn't flushed yet.
   * Computed by `hasPublishableChanges` in TemplateDetail — the rail must not
   * re-derive it from `template` alone, which misses the debounce window.
   */
  hasChanges: boolean;
  /** True once a draft autosave has failed and not yet succeeded again. */
  autosaveFailed: boolean;
  onPublish: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
}

export function DetailRail({
  template,
  state,
  stats,
  isEditing,
  saving,
  canPublish,
  hasChanges,
  autosaveFailed,
  onPublish,
  onDiscard,
  onCancel,
  onEdit,
  onPause,
  onResume,
}: Props) {
  const isDraft = template.status === "draft";
  const hasDraftEdits = template.draft_config != null;
  // `approval_rate` already arrives as a whole-number percentage — the stats
  // route rounds approved/human_decided*100 server-side. Multiplying by 100
  // again rendered a 64% template as "6400%". `null` means nothing has been
  // decided yet, which is 0% approved so far.
  const approvalRate = stats?.approval_rate ?? 0;
  const percent = `${approvalRate}%`;

  return (
    <aside
      className="flex h-full shrink-0 flex-col overflow-y-auto overflow-x-hidden"
      style={{
        width: 316,
        minWidth: 316,
        maxWidth: 316,
        borderLeft: "1px solid rgba(var(--gw-line-rgb),.07)",
        padding: "24px 22px",
        gap: 24,
      }}
    >
      {/* One shape, always. The section used to have three: two tiles, or a
          single tile when nothing was decided yet, or a "No reviews yet"
          sentence at zero — so the rail jumped as you moved between
          templates. A new template reads 0 reviews / 0% approved, which is
          the truth about it, and the skeleton never moves. */}
      {!isEditing && stats && (
        <section className="flex flex-col gap-3">
          <SectionHeader label="Activity" rail />
          <div className="flex gap-2">
            <StatTile value={String(stats.total_reviews)} caption="reviews" />
            {/* Green is the affirmative-decision ink, so it belongs on an
                approval rate that HAS approvals behind it. At 0% there is
                nothing affirmative to mark and the green reads as praise for
                a number that earned none. */}
            <StatTile value={percent} caption="approved" accent={approvalRate > 0} />
          </div>
          {stats.pending_now > 0 && (
            // "of them" binds this line to the tile's count, so the two facts
            // cannot read as one fact stated twice when the numbers coincide.
            <span className="text-[11.5px]" style={{ color: "var(--gw-t7)" }}>
              {stats.pending_now} of them waiting on a decision right now
            </span>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        {isEditing ? (
          <>
            {/* Honest UI: this line must never claim a save that is not
                happening. A failed autosave used to be a console.warn under a
                rail that said "Saving as you type", so an operator kept typing
                into a session that was no longer being persisted. */}
            <div className="flex items-start gap-2">
              <span
                className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full"
                style={{ background: autosaveFailed ? "var(--gw-red-t)" : "var(--gw-amber-t)" }}
              />
              <span
                className="text-[11.5px] leading-relaxed"
                style={{ color: autosaveFailed ? "var(--gw-red-t)" : "var(--gw-t6)" }}
              >
                {autosaveFailed
                  ? "Changes are not being saved. Check your connection, then publish to retry."
                  : "Saving as you type"}
              </span>
            </div>

            <PrimaryButton
              onClick={onPublish}
              disabled={saving || !canPublish || !hasChanges}
              height={37}
              full
              title={
                !hasChanges
                  ? "Nothing to publish yet. The live version already matches."
                  : canPublish
                    ? undefined
                    : "Every template needs at least one decision action, and a select field needs its options"
              }
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : isDraft ? "Publish" : "Publish changes"}
            </PrimaryButton>

            {!canPublish && (
              <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t7)" }}>
                {state.name.trim().length === 0
                  ? "Give the template a name first. The slug is taken from it and cannot be changed after publishing."
                  : "Publishing needs at least one decision action, and every select field needs its options."}
              </span>
            )}

            {/* Same signal as the Publish gate, so the pair can never
                contradict itself: an enabled Publish with a "Done editing"
                exit, or a disabled Publish over a "Discard changes" exit,
                both read as the rail arguing with itself. `hasDraftEdits`
                alone lagged the debounce window — the first keystrokes showed
                "Done editing", which silently KEEPS them. */}
            {hasChanges ? (
              <GhostButton onClick={onDiscard} disabled={saving} tone="danger" height={37} full>
                {isDraft ? "Discard draft" : "Discard unpublished changes"}
              </GhostButton>
            ) : (
              <GhostButton onClick={onCancel} disabled={saving} height={37} full>
                Done editing
              </GhostButton>
            )}
          </>
        ) : (
          <>
            {hasDraftEdits && (
              <div className="flex items-center gap-2 pb-1">
                <span
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ background: "var(--gw-amber-t)" }}
                />
                <span className="text-[11.5px]" style={{ color: "var(--gw-amber-t)" }}>
                  Unpublished changes
                </span>
              </div>
            )}
            <PrimaryButton onClick={onEdit} height={37} full>
              Edit template
            </PrimaryButton>
            {/* The rail owns the whole active/inactive toggle, both
                directions. It used to own only Deactivate, so an inactive
                template could be revived from the header's overflow menu
                alone — the same action living in two corners of the pane,
                and each corner holding only half of it. */}
            {template.status === "active" && (
              <GhostButton onClick={onPause} height={37} full>
                Deactivate
              </GhostButton>
            )}
            {template.status === "inactive" && (
              <GhostButton onClick={onResume} height={37} full>
                Activate
              </GhostButton>
            )}
          </>
        )}
      </section>

      <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
        {state.enableReviewLinks
          ? "Reviews from this template can be shared by link."
          : "Reviews from this template stay inside the project."}
      </span>
    </aside>
  );
}
