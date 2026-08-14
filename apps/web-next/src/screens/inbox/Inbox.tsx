/**
 * Inbox — 3-pane frame: [list 392px | detail area].
 *
 * Collapse is driven by the list header's panel button (spec §1b — the ONLY
 * collapse control); no floating seam handle.
 * 3b: detail pane wired to ReviewDetail (header + payload column + 11 renderers).
 * 3c-1: mutations (decide/action/veto) wired in RailDecision.
 * 3c-2: select mode (useMultiSelect from @/hooks/use-multi-select) + BulkBar
 *        (Archive/Delete — real endpoints). ChainStepper + ActivityThread in payload.
 *        Select mode enters from the overflow/bulk affordance, not the header.
 */
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import type { ZenOutletContext } from "~/shell/use-zen";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Review } from "@gatewerk/web-core/api/reviews";
import { useMultiSelect } from "@gatewerk/web-core/hooks/use-multi-select";
import { getReviewTitle } from "@gatewerk/web-core/lib/utils";
import { filterByTab, searchReviews, type Tab } from "./review-filters";
import { getNextItemId, getIdAfterDecision } from "./inbox-navigation-logic";
import { ReviewList } from "./ReviewList";
import { DetailEmpty } from "./DetailEmpty";
import { ReviewDetail } from "./detail/ReviewDetail";
import { BulkBar } from "./BulkBar";
import { IconButton } from "~/components/buttons";
import { markSeen, unreadReviewIdSet } from "~/api/notifications";
import { inboxReviewsQuery, notificationsQuery } from "~/route-queries";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { SampleWalkthrough } from "~/screens/onboarding/SampleWalkthrough";
import { isReviewerOnboardingComplete } from "~/screens/onboarding/reviewer-store";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { MobilePane } from "~/screens/mobile/MobilePane";
import { usePaneSelection } from "~/screens/mobile/use-pane-selection";

// The inbox shows open reviews only (spec §1); decided → History.
const OPEN_STATUSES = new Set([
  "pending",
  "awaiting_iteration",
  "awaiting_external",
  "monitoring",
]);

export function Inbox() {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const narrow = useNarrowViewport();
  // Selection lives in the URL (?review=<id>) so refresh, back, and shared links
  // restore it — and so /reviews/:id has somewhere to land. usePaneSelection
  // additionally makes a phone's opening of a review push a history entry, so
  // the OS back gesture returns to the list instead of leaving the app; see
  // its own doc comment for the full reasoning. `select` has the exact
  // `(id: string | null) => void` shape useMultiSelect already expects.
  const { selectedId, select: setSelectedId, close: closeDetail } = usePaneSelection(
    "review",
    narrow,
  );
  const { zen } = useOutletContext<ZenOutletContext>();
  // Zen forces the list shut without discarding the reviewer's own choice —
  // it reappears at whatever manual state it was in once zen ends.
  const [manualListCollapsed, setManualListCollapsed] = useState(false);
  const listCollapsed = manualListCollapsed || zen;
  const [selectMode, setSelectMode] = useState(false);

  const queryClient = useQueryClient();
  const { user } = useAuth();

  // The reviewer walkthrough, once, for the people it is for. Admins have their
  // own activation (the cloud wizard, or the first-run inbox when self-hosted)
  // and do not need to be taught what a decision is before they can see one.
  //
  // Read into state on mount rather than each render: the walkthrough writes
  // the flag when it finishes, and re-reading would tear it down mid-animation.
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  useEffect(() => {
    if (user && user.role !== "admin" && !isReviewerOnboardingComplete()) {
      setShowWalkthrough(true);
    }
  }, [user]);

  const { data, isLoading } = useQuery(inboxReviewsQuery);
  // Spec §1: the inbox lists OPEN reviews only — decided reviews belong in
  // History and must never appear here.
  const items = (data?.items ?? []).filter((r: Review) =>
    OPEN_STATUSES.has(r.status),
  );

  // Notification unread set: drives per-row dot.
  const { data: notifData } = useQuery(notificationsQuery);
  const unreadIds = unreadReviewIdSet(notifData?.notifications ?? []);

  // Multi-select state: useMultiSelect owns the checked set.
  // In select mode we use checkedIds (from selectedIds) directly.
  const multiSelect = useMultiSelect(items, selectedId, setSelectedId);

  // Tab + search filtering, shared by the collapsed strip and Cmd+Enter
  // advance (prototype iterates the same filtered `vis` set). ReviewList-local
  // template/date filters are not applied here — that state lives inside
  // ReviewList, which is unmounted while collapsed, and Inbox has no
  // visibility into it.
  const visibleQueue = searchReviews(
    filterByTab(items, tab),
    query,
    (r: Review) => getReviewTitle(r.payload, r.id),
  );
  const stripItems = visibleQueue.slice(0, 24);

  // Mark a review's notifications as seen when it is opened, then refresh the
  // unread count and the reviews list (e.g. status badges may change).
  //
  // The toggle reads `selectedId` directly rather than going through an updater.
  // markSeen is a network call, and a state updater is not a safe place for one:
  // React may invoke an updater more than once for a single dispatch, which
  // would fire the request twice. Reading the rendered value is correct here
  // because a click always acts on the selection the user is looking at.
  // Shared by handleSelect and handleAdvanceToNext: set the selection and
  // mark it seen. Split out of handleSelect because handleSelect ALSO
  // toggles off on re-click — a concept that doesn't apply when moving
  // forward through the queue via Cmd+Enter.
  function selectReview(id: string) {
    setSelectedId(id);
    void markSeen(id).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      void queryClient.invalidateQueries({ queryKey: ["reviews"] });
    });
  }

  function handleSelect(id: string) {
    if (selectedId === id) {
      setSelectedId(null);
      return;
    }
    selectReview(id);
  }

  // Cmd+Enter in the reply composer (or the decision rail, in future): submit,
  // then move on to whatever's next in visibleQueue — the same tab + search
  // filtered/ordered set the reviewer is already looking at (list expanded
  // or collapsed). Does not account for ReviewList's own template/date
  // filters, which are local to that component. No-op at the end of the
  // queue.
  function handleAdvanceToNext() {
    const nextId = getNextItemId(visibleQueue, selectedId);
    if (nextId) selectReview(nextId);
  }

  // A decided review leaves the open queue, so keeping it in the detail pane
  // leaves a reviewer staring at a card they can no longer act on next to a
  // list that has already dropped it. Move on instead: the next item in the
  // same filtered queue they are working through, the previous one if that
  // was the last, and otherwise clear the pane. On a phone there is no pane
  // to clear, so an empty queue means going back to the list.
  function handleDecided(decidedId: string) {
    const nextId = getIdAfterDecision(visibleQueue, decidedId);
    if (nextId) {
      selectReview(nextId);
      return;
    }
    if (narrow) {
      closeDetail();
      return;
    }
    setSelectedId(null);
  }

  function handleBulkClose() {
    multiSelect.clearSelection();
    setSelectMode(false);
  }

  // Phone layout: one pane at a time. No collapsed strip (that exists to free
  // room beside a detail pane, and on a phone there is no detail pane sharing
  // the screen with it) and no bulk select (desk only — see BulkBar, which
  // narrow never mounts).
  if (narrow) {
    if (selectedId) {
      // `items` is OPEN reviews only, so the moment a decision lands the row
      // leaves it and a title read from the list falls back to a generic word
      // while the reviewer is still looking at the thing they just decided.
      // ReviewDetail has already fetched the full review under ["review", id],
      // so fall back to that cache rather than to a placeholder.
      const selectedReview =
        items.find((r: Review) => r.id === selectedId) ??
        queryClient.getQueryData<Review>(["review", selectedId]) ??
        null;
      return (
        <MobilePane
          title={
            selectedReview ? getReviewTitle(selectedReview.payload, selectedReview.id) : "Review"
          }
          onBack={closeDetail}
        >
          {/* key={selectedId}: see the identical comment on the desktop
              ReviewDetail below — this is the same instance, just wrapped. */}
          <ReviewDetail
            key={selectedId}
            id={selectedId}
            onAdvanceToNext={handleAdvanceToNext}
            onDecided={handleDecided}
            stacked
          />
        </MobilePane>
      );
    }
    return (
      <div className="h-full min-w-0">
        {showWalkthrough ? (
          <SampleWalkthrough onDone={() => setShowWalkthrough(false)} />
        ) : (
          <ReviewList
            items={items}
            isLoading={isLoading}
            selectedId={selectedId}
            onSelect={handleSelect}
            tab={tab}
            onTab={setTab}
            query={query}
            onQuery={setQuery}
            onCollapse={() => {}}
            hideCollapse
            selectMode={false}
            checkedIds={multiSelect.selectedIds}
            onToggleRow={multiSelect.toggleMultiSelect}
            unreadIds={unreadIds}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0">
      {/* ── List column ── */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-in-out"
        style={{ width: listCollapsed ? 54 : 392 }}
      >
        {listCollapsed ? (
          /* Collapsed strip: priority-colored dots for the same filtered set
             as the expanded list (prototype miniStyle/miniDot, line 2032-2033) */
          <div className="flex h-full flex-col items-center gap-1 py-[14px]">
            {/* Expand toggle */}
            <span className="mb-1.5 flex">
              <IconButton title="Expand list" onClick={() => setManualListCollapsed(false)} size={34} radius={9}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line
                    x1="9.5"
                    y1="4"
                    x2="9.5"
                    y2="20"
                    strokeDasharray="2 2"
                  />
                </svg>
              </IconButton>
            </span>

            {/* Priority dots — clicking selects without expanding (prototype) */}
            {!isLoading &&
              stripItems.map((r: Review) => {
                const isUrgent =
                  (r.priority === "high" || r.priority === "critical") &&
                  r.status === "pending";
                const isWaiting =
                  r.status === "awaiting_iteration" ||
                  r.status === "awaiting_external";
                const selected = selectedId === r.id;
                const bg = isUrgent
                  ? "var(--gw-red-bar)"
                  : isWaiting
                    ? "var(--gw-amber-bar)"
                    : selected
                      ? "var(--gw-t3)"
                      : "rgba(var(--gw-line-rgb),.28)";
                return (
                  <button
                    key={r.id}
                    onClick={() => handleSelect(r.id)}
                    title={getReviewTitle(r.payload, r.id)}
                    className="flex w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none transition-colors"
                    style={{
                      height: selected ? 30 : 28,
                      background: selected
                        ? "rgba(var(--gw-line-rgb),.08)"
                        : "transparent",
                      boxShadow: selected
                        ? "inset 0 0 0 1px rgba(var(--gw-line-rgb),.09)"
                        : "none",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: selected ? 8 : 7,
                        height: selected ? 8 : 7,
                        borderRadius: "50%",
                        background: bg,
                      }}
                    />
                  </button>
                );
              })}
          </div>
        ) : (
          /* Full list; BulkBar docks in-flow below the rows (prototype) */
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <ReviewList
                items={items}
                isLoading={isLoading}
                selectedId={selectedId}
                onSelect={handleSelect}
                tab={tab}
                onTab={setTab}
                query={query}
                onQuery={setQuery}
                onCollapse={() => setManualListCollapsed(true)}
                selectMode={selectMode}
                checkedIds={multiSelect.selectedIds}
                onToggleRow={multiSelect.toggleMultiSelect}
                unreadIds={unreadIds}
              />
            </div>
            {/* BulkBar docks at the bottom of the list when in select mode */}
            {selectMode && (
              <BulkBar
                selectedIds={multiSelect.selectedIds}
                onClose={handleBulkClose}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Detail area ── */}
      <div
        className="m-[6px_6px_6px_0] min-w-0 flex-1 overflow-hidden rounded-[12px]"
        style={{
          background:
            "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          boxShadow:
            "0 12px 34px rgba(0,0,0,.4), inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
        }}
      >
        {showWalkthrough ? (
          <SampleWalkthrough onDone={() => setShowWalkthrough(false)} />
        ) : selectedId ? (
          /* key={selectedId} forces a remount when the selection changes, which
             resets the staged inline edits ReviewDetail owns. Without it React
             reuses the instance, the edit Map from the previous review survives,
             and — now that those edits actually ride along with the decision —
             approving review B would record an edit the reviewer made on review
             A, to a field B may not even have. ActivityThread one level down
             already carries a key for the same class of reason. */
          <ReviewDetail
            key={selectedId}
            id={selectedId}
            onAdvanceToNext={handleAdvanceToNext}
            onDecided={handleDecided}
          />
        ) : visibleQueue.length > 0 ? (
          /* One empty state per screen, not two (Empty States board, spec
             §acceptance 8). When the list itself is empty its own Tier 1 or
             Tier 2 state carries the whole message, and a second "select a
             review" panel beside it just says the same nothing twice. The
             detail pane is deliberately blank in that case. */
          <DetailEmpty />
        ) : null}
      </div>
    </div>
  );
}
