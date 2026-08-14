/**
 * The inbox list's Tier-2 states: the reviewer narrowed the list and nothing
 * survived.
 *
 * Every branch here is a dead end the reviewer built, so the only content that
 * earns its place is the way back — and it has to be the RIGHT way back. The
 * version this replaces treated any active filter as a search: a template or
 * date filter matching nothing said "No reviews match / Clear search" and its
 * reset cleared the query and every filter at once. Which cause is which now
 * comes from decideInboxEmptyCause, which is tested.
 *
 * Some causes carry a second line and some do not. That asymmetry is from the
 * design and is deliberate: the hint exists to say "your data is still there",
 * which only helps where a number can say it.
 *
 * Tier-1 (first run, all clear) lives in InboxFirstRun.tsx — it needs to know
 * whether the workspace is set up, which is a different question with different
 * answers.
 */

import { EmptyStateTier2, SearchTerm } from "~/components/empty-state";
import type { InboxEmptyCause } from "./inbox-empty-cause";

interface Props {
  /** Never "none" or "all-clear" — ReviewList routes those elsewhere. */
  cause: Exclude<InboxEmptyCause, { kind: "none" } | { kind: "all-clear" }>;
  query: string;
  /** Open reviews across all tabs. Says "your queue is not empty, this view is". */
  queueCount: number;
  /** Open reviews at high or critical priority — what "higher priority" means on the routine tab. */
  urgentCount: number;
  /** Open reviews on templates the current filter excludes. */
  otherTemplateCount: number;
  onShowAllTabs: () => void;
  onClearSearch: () => void;
  onResetTemplate: () => void;
  onResetDate: () => void;
  onClearAllFilters: () => void;
}

const TAB_TITLES: Record<"urgent" | "routine" | "waiting", string> = {
  urgent: "No urgent reviews right now",
  routine: "No routine reviews right now",
  waiting: "Nothing is waiting on others",
};

export function InboxEmpty({
  cause,
  query,
  queueCount,
  urgentCount,
  otherTemplateCount,
  onShowAllTabs,
  onClearSearch,
  onResetTemplate,
  onResetDate,
  onClearAllFilters,
}: Props) {
  switch (cause.kind) {
    case "tab": {
      // Only offer a count when there is one to offer. "You have 0 other
      // reviews in the queue" is worse than saying nothing.
      const hint =
        cause.tab === "urgent"
          ? queueCount > 0
            ? `You have ${queueCount} other reviews in the queue.`
            : undefined
          : cause.tab === "routine"
            ? urgentCount > 0
              ? `You have ${urgentCount} reviews at higher priority.`
              : undefined
            : undefined;
      return (
        <EmptyStateTier2
          title={TAB_TITLES[cause.tab]}
          hint={hint}
          resetLabel="Show all reviews"
          onReset={onShowAllTabs}
        />
      );
    }

    case "search":
      return (
        <EmptyStateTier2
          title={<>No reviews match <SearchTerm q={query} /></>}
          resetLabel="Clear search"
          onReset={onClearSearch}
        />
      );

    case "template":
      return (
        <EmptyStateTier2
          title="No reviews for these templates"
          hint={
            otherTemplateCount > 0
              ? `${otherTemplateCount} reviews on other templates.`
              : undefined
          }
          resetLabel="Reset template filter"
          onReset={onResetTemplate}
        />
      );

    case "date":
      return (
        <EmptyStateTier2
          title="No reviews in this range"
          resetLabel="Reset date filter"
          onReset={onResetDate}
        />
      );

    case "combined":
      return (
        <EmptyStateTier2
          title="No reviews match your filters"
          resetLabel="Clear all filters"
          onReset={onClearAllFilters}
        />
      );
  }
}
