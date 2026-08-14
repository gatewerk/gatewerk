import { useEffect } from "react";
import { stepSelection } from "./history-model";

/**
 * ↑/↓ browse (the empty state advertises it) and the Escape ladder. Branch
 * logic lives in stepSelection() — this hook is wiring only, because web-next
 * has no React render harness to test a hook body. "/" search focus lives in
 * the shared components/use-slash-focus.ts, mounted beside this hook.
 *
 * Escape: this listener sits on `document` at CAPTURE and calls
 * preventDefault() on every branch it handles. That is how this app orders the
 * Escape cascade — HistoryListHeader.tsx, screens/templates/_ui.tsx and
 * templates/detail/TemplateDetail.tsx all claim the key the same way, and
 * useZen (shell/use-zen.ts) sits last and bails on `defaultPrevented`.
 *
 * Two deliberate fall-throughs:
 *  - While typing in a field the key is the FIELD's to handle
 *    (ListSearchField clears first, blurs second, and stops the event
 *    itself), so this hook steps aside entirely.
 *  - With nothing to cancel at all, the key stays unclaimed so useZen can
 *    exit zen — a claimed no-op would make zen un-escapable on this screen.
 *
 * HistoryListHeader still owns the actual popover close. Its listener is also
 * document-capture and calls stopPropagation(), so it normally wins — but with
 * two capture listeners on the same node the order is registration-dependent,
 * so the `filterOpen` branch below is a real guard rather than a dead
 * failsafe: whichever of the two runs first, Escape closes the popover and
 * nothing else.
 *
 * Arrow keys are suppressed outright while the popover is open: the calendar
 * and checkbox rows inside it are plain buttons, not form fields, so the
 * in-field check alone would not stop ↑/↓ from also moving the list
 * selection underneath the popover.
 */
export function useHistoryKeys(opts: {
  visibleIds: string[];
  selectedId: string | null;
  filterOpen: boolean;
  setSelectedId: (id: string | null) => void;
  setFilterOpen: (v: boolean) => void;
}) {
  const { visibleIds, selectedId, filterOpen, setSelectedId, setFilterOpen } = opts;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      const inField = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "Escape") {
        if (filterOpen) setFilterOpen(false);
        else if (inField) return;
        else if (selectedId !== null) setSelectedId(null);
        else return;
        e.preventDefault();
        return;
      }
      if (inField) return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !filterOpen) {
        e.preventDefault();
        setSelectedId(stepSelection(visibleIds, selectedId, e.key === "ArrowDown" ? 1 : -1));
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // setSelectedId/setFilterOpen are the raw useState setters from
    // History.tsx (referentially stable); visibleIds/selectedId/filterOpen are
    // the real inputs. All are still listed for exhaustive-deps since ESLint
    // cannot see stability across the component boundary.
  }, [visibleIds, selectedId, filterOpen, setSelectedId, setFilterOpen]);
}
