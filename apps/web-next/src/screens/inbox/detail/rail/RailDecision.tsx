/**
 * RailDecision — Zone 4 §4: feedback textarea + stacked ActionButtons.
 *
 * Template actions: calls reviews.action(id, {action_id, feedback, version}).
 * Default approve/reject: calls reviews.decide(id, {decision, feedback}).
 * Monitoring: calls reviews.veto(id, note) / reviews.confirm(id).
 *
 * Decision-kind calls also carry `edited_payload` when the reviewer staged
 * inline edits in the payload column. Monitoring confirm/veto do not: they
 * acknowledge an action the agent already took, so there is no proposal left to
 * amend. See decide-body.ts for the merge rule and why it exists.
 *
 * requires_feedback guard: if button.requiresFeedback && feedback.trim() === ""
 *   → red sonner toast, does NOT fire the mutation.
 *
 * React-query invalidation: ["review", id] + ["reviews"] on success.
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reviews } from "@gatewerk/web-core/api/reviews";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { ActionButton } from "./ActionButton";
import type { ActionButtonState } from "./ActionButton";
import {
  toButtons,
  SYNTHETIC_APPROVE,
  SYNTHETIC_REJECT,
  MONITORING_CONFIRM,
  MONITORING_VETO,
} from "./action-tones";
import type { ActionButtonDescriptor } from "./action-tones";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import type { EditedPayloadHandle } from "../use-edited-payload";
import { mergeEditedPayload } from "../decide-body";

interface Props {
  review: Review;
  editedPayload: EditedPayloadHandle;
  /**
   * Called once a decision has landed and its confirmation flash has been
   * seen. The Inbox uses it to leave the decided review, which can no longer
   * be acted on and has already dropped out of the open queue beside it.
   */
  onDecided?: (reviewId: string) => void;
}

export function RailDecision({ review, editedPayload, onDecided }: Props) {
  const [feedback, setFeedback] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const buttons = toButtons(review);

  const isMonitoring =
    review.oversight === "monitoring" && review.status === "monitoring";

  // Does ANY button require feedback? Drives placeholder text.
  const anyRequiresFeedback = buttons.some((b) => b.requiresFeedback);
  const placeholder = anyRequiresFeedback
    ? "Feedback required for some actions"
    : "Optional feedback for the agent";

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["review", review.id] });
    queryClient.invalidateQueries({ queryKey: ["reviews"] });
  }

  const actionMutation = useMutation({
    mutationFn: ({
      btn,
      fb,
    }: {
      btn: ActionButtonDescriptor;
      fb: string;
    }) => {
      // Read once per submit, not per branch: the staged map is the reviewer's
      // work and every decision-kind path owes it to the server. getStaged()
      // (not the reactive `staged` field) because a blur-triggered commit
      // from this very click (focus leaving an open field to land on the
      // button) lands moments before this handler runs but may not have
      // re-rendered yet — the ref-backed getter is current regardless.
      //
      // Not pinned by a test at this call site — the race is timing-dependent
      // on React not having re-rendered yet, and jsdom always flushes first;
      // see inline-edit-decide-body.test.ts for the seam that IS testable.
      const edited = mergeEditedPayload(review.payload, editedPayload.getStaged());
      const withEdits = edited !== undefined ? { edited_payload: edited } : {};

      switch (btn.id) {
        case SYNTHETIC_APPROVE:
          return reviews.decide(review.id, {
            decision: "approved",
            feedback: fb || undefined,
            ...withEdits,
            version: review.current_version,
          });
        case SYNTHETIC_REJECT:
          return reviews.decide(review.id, {
            decision: "rejected",
            feedback: fb || undefined,
            ...withEdits,
            version: review.current_version,
          });
        case MONITORING_CONFIRM:
          return reviews.confirm(review.id);
        case MONITORING_VETO:
          return reviews.veto(review.id, fb || undefined);
        default:
          // Template action
          return reviews.action(review.id, {
            action_id: btn.actionId ?? btn.id,
            feedback: fb || undefined,
            ...withEdits,
            version: review.current_version,
          });
      }
    },
    onSuccess: () => {
      // The edits went with the decision; keeping them staged would let the
      // same edit ride a second, unrelated decision on this review.
      editedPayload.clear();
      invalidate();
      setDoneId(activeId);
      setActiveId(null);
      setFeedback("");
      // Clear done flash after 1.2s, then hand the reviewer on. Leaving the
      // pane immediately would swallow the only confirmation they get, so the
      // move waits for the same beat the flash already occupies.
      const decidedReviewId = review.id;
      setTimeout(() => {
        setDoneId(null);
        onDecided?.(decidedReviewId);
      }, 1200);
    },
    onError: (e: unknown) => {
      setActiveId(null);
      toast.error(e instanceof Error ? e.message : "Action failed");
    },
  });

  function handleClick(btn: ActionButtonDescriptor) {
    if (activeId !== null) return; // already mutating

    const fb = feedback.trim();

    if (btn.requiresFeedback && fb.length === 0) {
      toast.error(`"${btn.label}" requires feedback before submitting`);
      textareaRef.current?.focus();
      return;
    }

    setActiveId(btn.id);
    actionMutation.mutate({ btn, fb });
  }

  function buttonState(btn: ActionButtonDescriptor): ActionButtonState {
    if (doneId === btn.id) return "done";
    if (activeId === btn.id) return "loading";
    if (activeId !== null) return "disabled";
    return "idle";
  }

  return (
    <section>
      <RulerTickHeader label="Decision" marginClassName="mb-[13px] mt-0" endTick={false} />

      {/* Monitoring context hint */}
      {isMonitoring && (
        <p className="mb-2 font-mono text-[11px]" style={{ color: "var(--gw-amber-t)" }}>
          Agent already executed. Veto within the window.
        </p>
      )}

      {/* Feedback textarea */}
      <AutoGrowTextarea
        ref={textareaRef}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="mb-3 w-full rounded-[10px] p-2.5 font-sans text-[12.5px] leading-relaxed outline-none transition-colors"
        style={{
          background: "var(--gw-inset)",
          border: "1px solid rgba(var(--gw-line-rgb),.1)",
          color: "var(--gw-t3)",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.20)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.1)";
        }}
      />

      {/* Stacked ActionButtons: neutral → red → green (toButtons already sorted).
          gap 10 matches the buttons' own radius, so the stack breathes at the
          same rate as its corners round. */}
      <div className="flex flex-col gap-2.5">
        {buttons.map((btn) => (
          <ActionButton
            key={btn.id}
            label={btn.label}
            tone={btn.tone}
            state={buttonState(btn)}
            onClick={() => handleClick(btn)}
          />
        ))}
      </div>
    </section>
  );
}
