import { getDisplaySections } from "@gatewerk/web-core/lib/shortcuts";

/**
 * Returns true if the active element is an input/textarea/select,
 * meaning single-key shortcuts should NOT fire.
 */
export function isInputFocused(): boolean {
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

// Re-export display sections from the centralized registry
export { getDisplaySections };
