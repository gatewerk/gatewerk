/**
 * useSlashFocus — the "/" shortcut that ListSearchField's keycap advertises.
 * Document capture so it wins before any bubble listener; skipped while
 * already typing in a field. Honors the shortcuts registry's nav.search
 * binding rather than hardcoding "/", read once per mount (a rebind needs a
 * remount — the settings screen is not open while you are typing here).
 */
import { useEffect, type RefObject } from "react";
import { getMergedBinding, matchesBinding } from "@gatewerk/web-core/lib/shortcuts";

export function useSlashFocus(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const binding = getMergedBinding("nav.search");
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (!matchesBinding(e, binding)) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [inputRef]);
}
