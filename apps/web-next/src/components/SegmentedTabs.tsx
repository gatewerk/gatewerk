/**
 * SegmentedTabs — the list-column tab pill, extracted from the History header
 * (History's treatment is the standard for every
 * list column). 12px labels, the first tab hugs its label, the rest share the
 * remaining width evenly. Selection is neutral: green is reserved for
 * affirmative decisions and must not double as "this tab is active".
 *
 * Shared so the three list screens cannot drift apart again — this component
 * exists because they already had, three times.
 *
 * `equalWidth` opts out of the hug-first rule above. That rule assumes tab
 * one is a short catch-all ("All") next to longer peers, which is true for
 * every list-header consumer but not for a set of equal-weight options like
 * the API key form's Agent/Reviewer/Admin/Custom preset picker or the
 * Activity/Deliveries log switch — there "Agent" hugged its own label while
 * the flex:1 tabs split the rest, so the first pill read visibly narrower
 * than the others for no reason tied to its content.
 *
 * `size="lg"` is a second scale, not a second component: same shape and
 * colours, roomier padding and text. List-header consumers stay on the
 * default (`sm`) — that pill is deliberately compact next to a search box.
 * The template editor's Default priority toggle sits alone in a settings
 * row next to full-height inputs and read `sm` as undersized there.
 */

export interface SegmentedTab<T extends string> {
  value: T;
  label: string;
}

export function SegmentedTabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  equalWidth = false,
  size = "sm",
}: {
  tabs: readonly SegmentedTab<T>[];
  active: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  equalWidth?: boolean;
  size?: "sm" | "lg";
}) {
  const fontSize = size === "lg" ? 13 : 12;
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex min-w-0 flex-1 items-center gap-[2px] rounded-[9px]"
      style={{
        // `lg` fixes the pill to the row's standard control height
        // (INSET_INPUT_CLASS: 36px, border included) instead of deriving it
        // from padding + line-height, which drifted taller than every input
        // on the same screen. Buttons below fill this with height: "100%"
        // and centre their label via the existing flex classes.
        height: size === "lg" ? 36 : undefined,
        padding: 3,
        background: "rgba(var(--gw-hi-rgb),.03)",
        border: "1px solid rgba(var(--gw-line-rgb),.08)",
        boxSizing: "border-box",
      }}
    >
      {tabs.map((t, i) => {
        const isActive = t.value === active;
        // The first tab (All, on every screen) hugs its label; the others
        // share the rest evenly, so the pill's shape is stable whatever is
        // selected.
        const hugs = !equalWidth && i === 0;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.value)}
            className="gw-focus-ring flex cursor-pointer items-center justify-center whitespace-nowrap rounded-[6px] border-none transition-colors"
            style={{
              flex: hugs ? "0 0 auto" : "1",
              // `flex: 1` alone still respects the default `min-width: auto`
              // on a flex item, which floors it at its own content size. In
              // a roomy container that never bites, but shrink one (the
              // template editor's Default priority toggle) and the longer
              // label refuses to shrink as far as the shorter one — visibly
              // unequal pills despite equal flex-grow. `minWidth: 0` lets
              // flex-basis do its job.
              minWidth: hugs ? undefined : 0,
              height: size === "lg" ? "100%" : undefined,
              boxSizing: "border-box",
              padding: hugs
                ? size === "lg" ? "0 18px" : "5px 14px"
                : size === "lg" ? "0 12px" : "5px 4px",
              fontFamily: "inherit",
              fontSize,
              fontWeight: isActive ? 600 : 500,
              background: isActive ? "rgba(var(--gw-hi-rgb),.10)" : "transparent",
              color: isActive ? "var(--gw-t2)" : "var(--gw-t7)",
              // Inset ring copied verbatim from IconRail's ACTIVE_CLS
              // (shell/IconRail.tsx:39) so a selected pill and a selected
              // rail destination read as the same idea.
              boxShadow: isActive ? "inset 0 0 0 1px rgba(var(--gw-line-rgb),0.08)" : "none",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
