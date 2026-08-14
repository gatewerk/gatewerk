/**
 * DecisionRail — Zone 4 container: 316px, left hairline, 4 sections.
 *
 * Sections (top to bottom):
 *  1. Details (assignee, priority, created, irreversibility, callback)
 *  2. Review link (only when active_token exists)
 *  3. Notes (read-only)
 *  4. Decision (feedback + action buttons)
 */
import type { Review } from "@gatewerk/web-core/api/reviews";
import type { EditedPayloadHandle } from "../use-edited-payload";
import { RailDetails } from "./RailDetails";
import { RailReviewLink } from "./RailReviewLink";
import { RailNotes } from "./RailNotes";
import { RailDecision } from "./RailDecision";

interface Props {
  review: Review;
  /** Staged inline edits, so a decision can carry them. See decide-body.ts. */
  editedPayload: EditedPayloadHandle;
  onDecided?: (reviewId: string) => void;
  /**
   * Phone layout: the rail sits below the payload in the same scrolling
   * column instead of beside it, so it drops its fixed width and its left
   * hairline becomes a top one. Nothing else about the rail changes.
   */
  stacked?: boolean;
}

export function DecisionRail({ review, editedPayload, onDecided, stacked = false }: Props) {
  return (
    <aside
      className="flex h-full flex-col overflow-y-auto overflow-x-hidden"
      style={{
        ...(stacked
          ? {
              borderTop: "1px solid rgba(var(--gw-line-rgb),.07)",
              // Stacked, the last thing in this column is the Approve button
              // and the next thing down the screen is the tab bar. Without the
              // extra bottom padding they meet with no gap, so the primary
              // action of the whole product sits flush against navigation and
              // reads as part of it. Also clears an iOS home indicator.
              padding: "24px 22px calc(28px + env(safe-area-inset-bottom))",
            }
          : {
              width: 316,
              minWidth: 316,
              maxWidth: 316,
              borderLeft: "1px solid rgba(var(--gw-line-rgb),.07)",
              padding: "24px 22px",
            }),
        flexShrink: 0,
        // Sections are separated by whitespace ONLY (spec §4/§5) — the rail
        // provides padding + gap; sections carry no borders of their own.
        gap: 24,
      }}
    >
      <RailDetails review={review} />
      <RailReviewLink review={review} />
      <RailNotes
        reviewId={review.id}
        projectId={review.project_id}
        templateId={review.template_id ?? null}
      />
      <RailDecision review={review} editedPayload={editedPayload} onDecided={onDecided} />
    </aside>
  );
}
