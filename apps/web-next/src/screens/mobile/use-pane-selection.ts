/**
 * Shared list/detail selection for the screens that have a phone layout.
 *
 * Selection lives in the query string on every width, because a reload or a
 * shared link should restore it. What changes with width is whether opening a
 * detail creates a history entry:
 *
 *  - On a laptop both panes are on screen at once, so selecting a row is not
 *    navigation. It replaces, exactly as Inbox has always done. Otherwise the
 *    back button would step backwards through every row a reviewer clicked.
 *  - On a phone the detail IS the screen. Opening one has to push, or the OS
 *    back gesture skips the list entirely and leaves for whatever the reviewer
 *    was looking at before. That was a real bug: back from a History entry
 *    landed on Settings.
 *
 * `close` mirrors whichever of those happened. When this screen pushed the
 * entry it pops it, so the back arrow and the OS gesture do the same thing
 * rather than fighting. When it did not push, which is the deep link case
 * where someone opened /history?entry=… directly, popping would leave the app,
 * so it clears the param instead and the reviewer lands on the list.
 */
import { useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";

export interface PaneSelection {
  selectedId: string | null;
  /** Open a row, or pass null to close. Pushes only when a phone opens one. */
  select: (id: string | null) => void;
  /** Leave the detail. Safe on a deep link, where there is nothing to pop. */
  close: () => void;
}

export function usePaneSelection(param: string, narrow: boolean): PaneSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Whether THIS mount pushed the entry currently showing. A ref, not state:
  // flipping it must not re-render, and it is read only inside callbacks.
  const pushedHere = useRef(false);

  const selectedId = searchParams.get(param) || null;

  const write = useCallback(
    (id: string | null, replace: boolean) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set(param, id);
          else next.delete(param);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams, param],
  );

  const select = useCallback(
    (id: string | null) => {
      // Opening means going from no selection to one. Switching directly from
      // one row to another on a phone is not a new screen, it is the same
      // screen showing something else, so it replaces and back still returns
      // to the list rather than walking the rows in reverse.
      const opening = id !== null && selectedId === null;
      const shouldPush = narrow && opening;
      if (shouldPush) pushedHere.current = true;
      write(id, !shouldPush);
    },
    [narrow, selectedId, write],
  );

  const close = useCallback(() => {
    if (pushedHere.current) {
      pushedHere.current = false;
      navigate(-1);
      return;
    }
    write(null, true);
  }, [navigate, write]);

  return { selectedId, select, close };
}
