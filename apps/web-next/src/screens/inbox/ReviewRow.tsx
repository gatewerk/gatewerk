/**
 * ReviewRow — a single row in the Inbox list.
 *
 * Matches the prototype row markup:
 *   - flex gap-[11px] p-[11px_13px] rounded-[11px]
 *   - NO left priority bar (prototype renders none; urgency = stamps + chain tick)
 *   - Title 14px 550 (600 when selected), text-t4 → text-t1, truncate
 *   - Timestamp 11.5px text-t10, right of title (relative)
 *   - Meta line: mono template_slug, optional version chip, right-aligned stamps
 *   - Status stamps: URGENT (red), WAITING (amber), MONITORING (blue)
 *   - Chain tick: 3 segments + n/total label
 *   - Decided rows → opacity-50
 */
import { Check } from "lucide-react";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { getReviewTitle, timeAgo } from "@gatewerk/web-core/lib/utils";
import { StatusBadge, type BorderedTone } from "~/components/StatusBadge";

type Props = {
  review: Review;
  isSelected: boolean;
  onClick: () => void;
  /** When true, left side shows a checkbox instead of the priority bar. */
  selectMode?: boolean;
  /** Whether this row is checked in bulk selection. */
  isChecked?: boolean;
  /** When true, renders a leading unread dot and bumps title weight. */
  unread?: boolean;
};


function ChainTick({
  step,
  total,
}: {
  step: number;
  total: number;
}) {
  // 3 segment dots, first = always blue (current position), rest fill if <= step
  const dots = [1, 2, 3].map((i) =>
    i <= step
      ? "var(--gw-blue-bar)"
      : "rgba(var(--gw-line-rgb),.14)",
  );
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex gap-[3px]">
        {dots.map((color, i) => (
          <span
            key={i}
            style={{
              width: 12,
              height: 3,
              borderRadius: 2,
              background: color,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
        ))}
      </span>
      <span
        className="font-mono text-[9.5px] font-semibold"
        style={{ color: "var(--gw-blue-t)" }}
      >
        {step}/{total}
      </span>
    </span>
  );
}

function DecidedChip({ decision }: { decision: string | null }) {
  let tone: BorderedTone = "neutral";

  if (decision === "approved" || decision === "confirmed") {
    tone = "green";
  } else if (decision === "rejected" || decision === "vetoed") {
    tone = "red";
  }

  const label =
    decision === "approved"
      ? "Approved"
      : decision === "rejected"
        ? "Rejected"
        : decision === "confirmed"
          ? "Confirmed"
          : decision === "vetoed"
            ? "Vetoed"
            : (decision ?? "Decided");

  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/**
 * NotDeliveredChip — flags a review whose "your turn" notification email
 * hard bounced (Task 7). An undelivered notification is a correctness bug
 * for an oversight product: the reviewer this row is assigned to may never
 * know it exists. Destructive tone, matching DecidedChip's rejected/vetoed
 * styling exactly (same tokens, no new color introduced).
 */
function NotDeliveredChip() {
  return <StatusBadge tone="red">Email not delivered</StatusBadge>;
}

export function ReviewRow({
  review,
  isSelected,
  onClick,
  selectMode = false,
  isChecked = false,
  unread = false,
}: Props) {
  const title = getReviewTitle(review.payload, review.id);
  const ts = timeAgo(review.created_at);
  const isDecided = review.status === "decided";
  const isUrgent =
    (review.priority === "high" || review.priority === "critical") &&
    review.status === "pending";
  const isWaiting =
    review.status === "awaiting_iteration" ||
    review.status === "awaiting_external";
  const isMonitoring = review.status === "monitoring";
  const hasChain =
    review.chain_step_number != null && review.chain_total_steps != null;

  // Row bg/border when selected (raised card, never colored)
  const selectedStyle = isSelected
    ? {
        background: "rgba(var(--gw-hi-rgb),.05)",
        border: "1px solid rgba(var(--gw-line-rgb),.09)",
      }
    : {
        border: "1px solid transparent",
      };

  return (
    <button
      onClick={onClick}
      className="flex w-full gap-[11px] rounded-[11px] text-left outline-none transition-colors hover:bg-[rgba(var(--gw-line-rgb),.03)] cursor-pointer"
      style={{
        padding: "11px 13px",
        opacity: isDecided ? 0.5 : 1,
        ...selectedStyle,
      }}
    >
      {/* Left slot: checkbox in select mode only — no priority bar (prototype has none) */}
      {selectMode && (
        <div
          className="flex h-[18px] w-[18px] shrink-0 self-center items-center justify-center rounded-[5px]"
          style={{
            border: isChecked
              ? "1.5px solid var(--gw-t3)"
              : "1.5px solid rgba(var(--gw-line-rgb),.24)",
            background: isChecked ? "var(--gw-t3)" : "transparent",
            transition: "background .12s, border-color .12s",
          }}
        >
          {isChecked && <Check size={11} strokeWidth={3.2} style={{ color: "var(--gw-green-ink)" }} />}
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Title + timestamp row */}
        <div className="flex items-center gap-2">
          {/* Unread dot — leading green pulse when review has unread notifications */}
          {unread && (
            <span
              data-testid="unread-dot"
              aria-label="Unread"
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                background: "rgba(var(--gw-green-rgb),1)",
              }}
            />
          )}
          <div
            className="min-w-0 flex-1 truncate text-[14px]"
            style={{
              fontWeight: isSelected ? 600 : unread ? 600 : 550,
              color: isSelected ? "var(--gw-t1)" : unread ? "var(--gw-t2)" : "var(--gw-t4)",
            }}
          >
            {title}
          </div>
          <div className="shrink-0 text-[11.5px] text-t8">{ts}</div>
        </div>

        {/* Meta line */}
        <div className="mt-[7px] flex items-center gap-[7px]">
          {/* Template slug */}
          <span className="min-w-0 truncate font-mono text-[11px] text-t8">
            {review.template_slug ?? review.template?.name ?? ""}
          </span>

          {/* Version chip — when current_version > 1 */}
          {review.current_version > 1 && (
            <span
              className="shrink-0 font-mono text-[10px] font-medium text-t5"
              style={{
                background: "rgba(var(--gw-line-rgb),.06)",
                borderRadius: 4,
                padding: "1px 5px",
              }}
            >
              v{review.current_version}
            </span>
          )}

          {/* Right-aligned stamps */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* URGENT stamp */}
            {isUrgent && (
              <span
                className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em]"
                style={{
                  color: "var(--gw-red-t)",
                  border: "1px solid rgba(var(--gw-red-rgb),.42)",
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                URGENT
              </span>
            )}

            {/* WAITING stamp */}
            {isWaiting && (
              <span
                className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em]"
                style={{
                  color: "var(--gw-amber-t)",
                  border: "1px solid rgba(var(--gw-amber-rgb),.4)",
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                WAITING
              </span>
            )}

            {/* MONITORING stamp */}
            {isMonitoring && (
              <span
                className="font-mono text-[9.5px] font-semibold uppercase tracking-[.12em]"
                style={{
                  color: "var(--gw-blue-t)",
                  border: "1px solid rgba(var(--gw-blue-rgb),.42)",
                  borderRadius: 4,
                  padding: "2px 6px",
                }}
              >
                MONITORING
              </span>
            )}

            {/* Chain tick — hidden on decided and urgent rows (prototype mChain) */}
            {hasChain && !isDecided && !isUrgent && (
              <ChainTick
                step={review.chain_step_number!}
                total={review.chain_total_steps!}
              />
            )}

            {/* Notification delivery failed chip */}
            {review.notification_delivery_failed && <NotDeliveredChip />}

            {/* Decided chip */}
            {isDecided && <DecidedChip decision={review.decision ?? null} />}
          </span>
        </div>
      </div>
    </button>
  );
}
