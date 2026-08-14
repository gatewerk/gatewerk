import { useState, useEffect } from "react";

/**
 * useRailVisible — returns true when the viewport is wide enough to show the
 * decision rail (≥1120px). Mirrors the isMobile pattern in Inbox.tsx (window
 * matchMedia + change listener + SSR-safe initializer).
 *
 * 1120px matches the spec's min-width for the root container and keeps the
 * breakpoint in one place so changing the threshold is a single edit.
 */
export function useRailVisible(): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof window !== "undefined"
        ? window.matchMedia("(min-width: 1120px)").matches
        : false,
  );

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1120px)");
    const handler = (e: MediaQueryListEvent) => setVisible(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return visible;
}
