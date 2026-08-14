/**
 * HistoryRow — one decided review in the list.
 *
 * The row follows the INBOX's row language
 * (ReviewRow.tsx — no left bar, 14px title, 11px/13px padding), which
 * overrides the History prototype's per-row decision bar. With real data the
 * bars read as a wall of green (nearly every record is approved), decoration
 * rather than information; the outcome in words lives in the detail's
 * Details rail.
 *
 * Selection is a neutral raised card, never green. Green means "affirmative
 * decision" everywhere in this product, and a selected rejection tinted green
 * would say something false. The card is drawn with a border that is always
 * present and only changes colour, so selecting a row never shifts the list
 * by a pixel.
 *
 * The timestamp is compact ("2h", "9d", "3wk") — a list convention only. The
 * detail pane keeps prose "1d ago".
 */

import type { Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle, timeAgoShort } from "@gatewerk/web-core/lib/utils";
import { resolvedAt } from "./history-model";

interface Props {
  review: Review;
  isSelected: boolean;
  onClick: () => void;
  /**
   * The instant the whole render pass is measured against, so every row in one
   * pass ages against the same clock.
   */
  now: Date;
}

export function HistoryRow({ review, isSelected, onClick, now }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? "true" : undefined}
      className="w-full cursor-pointer rounded-[11px] text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),.03)]"
      style={{
        padding: "11px 13px",
        background: isSelected ? "rgba(var(--gw-hi-rgb),.045)" : undefined,
        border: isSelected
          ? "1px solid rgba(var(--gw-line-rgb),.09)"
          : "1px solid transparent",
      }}
    >
      <span className="flex items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate"
          style={{
            fontSize: 14,
            fontWeight: isSelected ? 600 : 550,
            color: isSelected ? "var(--gw-t1)" : "var(--gw-t4)",
          }}
        >
          {getReviewTitle(review.payload ?? {}, review.id)}
        </span>
        <span className="shrink-0" style={{ fontSize: 11.5, color: "var(--gw-t10)" }}>
          {timeAgoShort(resolvedAt(review), now)}
        </span>
      </span>

      <span
        className="block min-w-0 truncate font-mono"
        style={{
          marginTop: 7,
          fontSize: 11,
          color: isSelected ? "var(--gw-t6)" : "var(--gw-t8)",
        }}
      >
        {review.template_slug}
      </span>
    </button>
  );
}
