/**
 * ReviewDetail — container for a selected review's detail pane.
 *
 * Fetches via reviews.get(id) (read-only; no mutations in 3b).
 * Composes DetailHeader (Zone 2) + PayloadColumn (Zone 3) + DecisionRail (Zone 4).
 * Body row: [PayloadColumn flex-1 | DecisionRail 316px].
 */
import { useQuery } from "@tanstack/react-query";
import { reviews } from "@gatewerk/web-core/api/reviews";
import { Skeleton } from "~/components/skeleton";
import { useEditedPayload } from "./use-edited-payload";
import { DetailHeader } from "./DetailHeader";
import { PayloadColumn } from "./PayloadColumn";
import { DecisionRail } from "./rail/DecisionRail";

interface Props {
  id: string;
  onAdvanceToNext: () => void;
  onDecided?: (reviewId: string) => void;
  /**
   * Phone layout: payload and decision rail stack in one scrolling column
   * instead of sitting side by side. The decision sections keep their order,
   * so the buttons stay the last thing a reviewer reaches, after the payload
   * they are deciding on. That ordering is the point: it is what stops
   * somebody approving a request they have not scrolled through.
   */
  stacked?: boolean;
}

function LoadingSkeleton() {
  return (
    <div className="p-7">
      <Skeleton className="mb-3" width="75%" height={24} radius={7} style={{ background: "rgba(var(--gw-line-rgb),.08)" }} />
      <Skeleton className="mb-2" width="33%" height={12} radius={5} style={{ background: "rgba(var(--gw-line-rgb),.06)" }} />
      <div className="mt-6 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-4">
            <Skeleton width={120} height={16} radius={5} style={{ background: "rgba(var(--gw-line-rgb),.06)" }} />
            <Skeleton height={16} radius={5} style={{ width: "auto", flex: 1, background: "rgba(var(--gw-line-rgb),.05)" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReviewDetail({ id, onAdvanceToNext, onDecided, stacked = false }: Props) {
  const { data: review, isLoading, error, refetch } = useQuery({
    queryKey: ["review", id],
    queryFn: () => reviews.get(id),
    enabled: !!id,
    staleTime: 60_000,
  });

  // Staged inline edits. They are read in two places: PayloadColumn renders
  // them, and DecisionRail sends them with the decision. Threading them to the
  // rail is what makes an inline edit survive Approve — before that they were
  // staged, displayed, and then dropped on the floor at the moment of decision.
  const editedPayload = useEditedPayload();

  if (isLoading) return <LoadingSkeleton />;

  if (error || !review) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-[13px]" style={{ color: "var(--gw-red-t)" }}>
          {error instanceof Error ? error.message : "Review not found"}
        </p>
        <button
          type="button"
          className="cursor-pointer border-none bg-transparent text-[12px] font-medium transition-opacity hover:opacity-70"
          style={{ color: "var(--gw-t7)" }}
          onClick={() => void refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Zone 2 — Detail header */}
      <DetailHeader review={review} />

      {/* Zone 3 + Zone 4: [PayloadColumn flex-1 | DecisionRail 316px] on a
          laptop; stacked in one scrolling column, payload first, on a phone
          (see the `stacked` prop doc above for why the order is load
          bearing). */}
      {stacked ? (
        // A flex column, not a plain block: DecisionRail keeps its own
        // `h-full` (deliberately untouched, see DecisionRail.tsx), and inside
        // a block container that would stretch it to the whole scroll area's
        // height and leave dead space below its buttons. As a column flex
        // item its height instead comes from content. min-w-0 on both
        // children is the flex analogue of the grid `minmax(0, 1fr)` rule:
        // without it, content that cannot shrink pushes the item wider than
        // the track and this container's overflow-y:auto clips it sideways
        // instead of the payload wrapping.
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="min-w-0">
            <PayloadColumn review={review} editedPayload={editedPayload} onAdvanceToNext={onAdvanceToNext} />
          </div>
          <div className="min-w-0">
            <DecisionRail review={review} editedPayload={editedPayload} onDecided={onDecided} stacked />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PayloadColumn review={review} editedPayload={editedPayload} onAdvanceToNext={onAdvanceToNext} />
          </div>
          {/* Zone 4 — 316px decision rail (3c-1) */}
          <DecisionRail review={review} editedPayload={editedPayload} onDecided={onDecided} />
        </div>
      )}
    </div>
  );
}
