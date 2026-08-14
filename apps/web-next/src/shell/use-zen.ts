import { useState, useEffect, useCallback } from "react";

interface ZenState {
  zen: boolean;
  toggleZen: () => void;
  exitZen: () => void;
}

/**
 * Shape handed down through AppShell's `<Outlet context={...} />`. The list
 * screens (Inbox, History, Templates) read `zen` from there rather than
 * calling `useZen()` themselves — a second call would mount its own
 * `useState` and its own document keydown listener, a second zen that starts
 * independent of AppShell's and only coincidentally toggles in step with it.
 */
export interface ZenOutletContext {
  zen: boolean;
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function useZen(): ZenState {
  const [zen, setZen] = useState(false);

  const toggleZen = useCallback(() => setZen((z) => !z), []);
  const exitZen = useCallback(() => setZen(false), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "z" || e.key === "Z") {
        // Guard: ignore while the user is typing
        if (isTypingTarget(document.activeElement)) return;
        // Guard: ignore with modifier keys
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        setZen((z) => !z);
        return;
      }
      if (e.key === "Escape") {
        // Last in the Escape cascade. A popover, a modal or an open editor
        // claims the key with preventDefault; without this check one Escape
        // inside the template editor closed the popover, abandoned the edit AND
        // dropped out of zen at once.
        if (e.defaultPrevented) return;
        setZen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return { zen, toggleZen, exitZen };
}
