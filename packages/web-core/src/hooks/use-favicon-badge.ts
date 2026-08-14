import { useEffect } from "react";

const DEFAULT_HREF = "/gatewerk.svg";
const BADGE_HREF = "/gatewerk-badge.svg";

/**
 * Swap the browser tab favicon to a badged variant when there are pending
 * reviews. The badge SVG lives at /public/gatewerk-badge.svg and adds a
 * corner dot in the accent color. Restores the default when `active` flips
 * back to false.
 */
export function useFaviconBadge(active: boolean): void {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) return;
    const target = active ? BADGE_HREF : DEFAULT_HREF;
    if (link.getAttribute("href") === target) return;
    link.setAttribute("href", target);
  }, [active]);
}
