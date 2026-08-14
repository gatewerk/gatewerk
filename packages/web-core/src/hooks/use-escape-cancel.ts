import { useEffect, useRef } from "react";

export type EscapeHandler = { isActive: boolean; cancel: () => void };

/**
 * Priority-ordered Escape stacking. Iterates
 * `handlers` in order on every Escape; first `isActive` wins, calls
 * stopPropagation+preventDefault, runs cancel, returns. The handlers ref
 * pattern keeps a single window listener for the component lifetime so
 * per-render handler-array changes don't re-bind the listener.
 *
 * Bubble phase by default. Capture-phase listeners (Modal, DropdownMenu via
 * React root delegation in React 17+) still win first; this hook is the
 * lower-priority surface for inbox-level layers (search input value, list
 * selection, etc.).
 */
export function useEscapeCancel(handlers: EscapeHandler[]): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // React 17+ root delegation does NOT stop a native event from bubbling
      // to window listeners after a synthetic-event stopPropagation; native
      // `defaultPrevented` is the only reliable cross-tree signal that an
      // upstream handler claimed the keystroke. DropdownMenu calls
      // preventDefault on its menu-level Escape; this guard defers to it.
      if (e.defaultPrevented) return;
      // Active element is editable — its local onKeyDown owns Escape (e.g.
      // search input blurs on Escape via its own handler). Don't stomp.
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      // Active element is inside an open ARIA menu — DropdownMenu owns
      // Escape. (Modal owns its own via a capture-phase listener and never
      // reaches this hook.)
      if (ae?.closest('[role="menu"]')) return;
      // DOM-presence guard: DropdownMenu sets focus back to its trigger
      // button synchronously via close()'s `triggerRef.focus()`, so by the
      // time this bubble-phase listener runs, document.activeElement may
      // already be the trigger. The menu element itself stays mounted
      // through useAnimatedPresence's exit transition, so checking for any
      // open [role="menu"] in the document gives the cross-tree signal we
      // need to defer to DropdownMenu's own Escape handler.
      if (document.querySelector('[role="menu"]')) return;
      for (const handler of handlersRef.current) {
        if (handler.isActive) {
          e.preventDefault();
          e.stopPropagation();
          handler.cancel();
          return;
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
