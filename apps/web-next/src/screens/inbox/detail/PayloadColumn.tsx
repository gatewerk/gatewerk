/**
 * PayloadColumn — Zone 3: waiting banner + fields + chain stepper + activity.
 *
 * Receives editedPayload handle from ReviewDetail; no server mutations here.
 * Chain stepper and activity thread are appended below the fields.
 */
import type { Review } from "@gatewerk/web-core/api/reviews";
import type { EditedPayloadHandle } from "./use-edited-payload";
import { resolveFields } from "./payload-fields";
import { FieldRow } from "./FieldRow";
import { ChainStepper } from "./ChainStepper";
import { ActivityThread } from "./ActivityThread";

interface Props {
  review: Review;
  editedPayload: EditedPayloadHandle;
  onAdvanceToNext: () => void;
  /**
   * The chain stepper and the activity thread. Off for the onboarding sample:
   * its queries are already gated on the sentinel, but a reply composer that
   * accepts text and sends it nowhere is a promise the walkthrough cannot keep,
   * and the lesson is about the fields and the decision, not the thread.
   */
  showActivity?: boolean;
}

const WAITING_BANNERS: Record<string, string> = {
  awaiting_iteration: "Waiting on agent to resubmit",
  awaiting_external: "Waiting on external reviewer",
};

export function PayloadColumn({
  review,
  editedPayload,
  onAdvanceToNext,
  showActivity = true,
}: Props) {
  const banner = WAITING_BANNERS[review.status] ?? null;
  const fields = resolveFields(review);
  const originalPayload = review.payload ?? {};

  return (
    // Sections separated by the column's 28px gap (prototype payload column)
    <div className="flex flex-col px-7 py-5" style={{ minWidth: 0, gap: 28 }}>
      {/* Waiting banner */}
      {banner && (
        <div
          className="rounded-[9px] px-4 py-2.5 font-mono text-[12px]"
          style={{
            border: "1px solid rgba(var(--gw-amber-rgb),.35)",
            background: "rgba(var(--gw-amber-rgb),.07)",
            color: "var(--gw-amber-t)",
          }}
        >
          {banner}
        </div>
      )}

      {/* Field rows — grouped by whitespace, 4px gaps, no dividers (spec §4) */}
      <div className="flex flex-col gap-[4px]">
        {fields.length === 0 && (
          <p className="py-6 text-center text-[12px]" style={{ color: "var(--gw-t9)" }}>
            No payload attached to this review.
          </p>
        )}
        {fields.map((field) => {
          const originalValue = originalPayload[field.name] ?? null;
          const isEdited = editedPayload.has(field.name);
          const displayValue = isEdited ? editedPayload.get(field.name) : originalValue;

          return (
            <FieldRow
              key={field.name}
              field={field}
              displayValue={displayValue}
              originalValue={originalValue}
              isEdited={isEdited}
              onCommit={(v) => editedPayload.set(field.name, v, originalValue)}
              onRevert={() => editedPayload.revert(field.name)}
            />
          );
        })}
      </div>

      {showActivity && (
        <>
          {/* Chain stepper — renders null when review is not in a chain */}
          <ChainStepper
            reviewId={review.id}
            chainRunId={review.chain_run_id ?? ""}
          />

          {/* Activity thread — thread replies + version submissions.
              key={review.id} forces a full unmount/remount on review change: this
              component holds local state (optimisticNotes) that must reset per
              review, and without a key React reuses the instance whenever the
              next review's query data is already cached (no loading skeleton, so
              no unmount happens for free) — leaking an optimistic reply or
              misdirecting an in-flight mutation's success handler onto the wrong
              review. */}
          <ActivityThread key={review.id} reviewId={review.id} projectId={review.project_id} onAdvanceToNext={onAdvanceToNext} />
        </>
      )}
    </div>
  );
}
