/**
 * action-tones.ts — pure: maps a Review into an ordered ActionButtonDescriptor[].
 *
 * STATUS-AWARE (spec §S14/§S14b): actions are filtered by enabled_for_status
 * against the review's current status via the shared filterEnabled +
 * withSystemDefaults pipeline (same as the old app's RailDecisionSection).
 * On awaiting_iteration this yields "Cancel Iteration" (neutral, reverts to
 * pending) + "Reject" (reject_from_iteration, from the API snapshot) —
 * never Approve/Reject, which the API would 409.
 *
 * Tone mapping is NOT decided here — it is `actionTone` in
 * web-core/state/action-tone.ts, which the template editor's action chip
 * reads too, so the editor can only ever preview what this rail will draw.
 *
 * Order: neutral → red → green (primary last per spec).
 *
 * Monitoring reviews (oversight === "monitoring" && status === "monitoring"):
 *   synthetic Confirm (green) + Veto (red) instead of template actions.
 *
 * Default when no template actions on a decidable status (pending /
 * awaiting_external): approve (green) + reject (red).
 *
 * Tested in action-tones.test.ts — no side effects.
 */
import { normalizeTemplateActions, type ReviewStatus } from "@gatewerk/shared";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";
import { filterEnabled, withSystemDefaults } from "@gatewerk/web-core/state/inbox/action-row-state";
import { actionTone, type ActionTone } from "@gatewerk/web-core/state/action-tone";
import type { Review } from "@gatewerk/web-core/api/reviews";

export type { ActionTone };

export interface ActionButtonDescriptor {
  id: string;
  label: string;
  tone: ActionTone;
  requiresFeedback: boolean;
  /** "template" | "monitoring" | "default" */
  kind: "template" | "monitoring" | "default";
  /** For template actions: the canonical action_id to pass to reviews.action */
  actionId?: string;
}

// Synthetic ids for the default approve/reject path and monitoring.
const SYNTHETIC_APPROVE = "__approve__";
const SYNTHETIC_REJECT = "__reject__";
const MONITORING_CONFIRM = "__confirm__";
const MONITORING_VETO = "__veto__";

const TONE_ORDER: Record<ActionTone, number> = { neutral: 0, red: 1, green: 2 };

export function toButtons(review: Review): ActionButtonDescriptor[] {
  // Monitoring path: Confirm (green) + Veto (red).
  if (review.oversight === "monitoring" && review.status === "monitoring") {
    return [
      {
        id: MONITORING_VETO,
        label: "Veto",
        tone: "red",
        requiresFeedback: false,
        kind: "monitoring",
      },
      {
        id: MONITORING_CONFIRM,
        label: "Confirm",
        tone: "green",
        requiresFeedback: false,
        kind: "monitoring",
      },
    ];
  }

  const rawActions = normalizeTemplateActions(
    review.template?.actions ?? [],
  ) as TemplateActionConfigCanonical[];
  const status = review.status as ReviewStatus;
  // Inject system presets (cancel_iteration on awaiting_iteration), then
  // keep only actions enabled for the review's CURRENT status.
  const canonical = filterEnabled(withSystemDefaults(rawActions, status), status);

  // Default when no template actions on a decidable status.
  if (canonical.length === 0) {
    if (status !== "pending" && status !== "awaiting_external") return [];
    return [
      {
        id: SYNTHETIC_REJECT,
        label: "Reject",
        tone: "red",
        requiresFeedback: false,
        kind: "default",
      },
      {
        id: SYNTHETIC_APPROVE,
        label: "Approve",
        tone: "green",
        requiresFeedback: false,
        kind: "default",
      },
    ];
  }

  const descriptors: ActionButtonDescriptor[] = canonical.map((a) => ({
    id: a.id,
    label: a.label,
    tone: actionTone(a),
    requiresFeedback: a.requires_feedback ?? false,
    kind: "template" as const,
    actionId: a.id,
  }));

  // Sort: neutral → red → green (primary last).
  return descriptors.slice().sort(
    (a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone],
  );
}

// Re-export sentinel ids for callers (RailDecision, tests).
export { SYNTHETIC_APPROVE, SYNTHETIC_REJECT, MONITORING_CONFIRM, MONITORING_VETO };
