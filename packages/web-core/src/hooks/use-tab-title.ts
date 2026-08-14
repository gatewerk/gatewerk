import { useEffect, useRef } from "react";
import { formatTabTitle } from "@gatewerk/web-core/lib/live-events";

/**
 * Keep the browser tab title in sync with the pending-review count. Strips
 * any prior `(N)` prefix on first run so repeated renders don't double-
 * prefix. Restores the original title on unmount.
 */
export function useTabTitle(pendingCount: number, base = "Gatewerk"): void {
  const originalRef = useRef<string | null>(null);

  useEffect(() => {
    if (originalRef.current === null) {
      const stripped = document.title.replace(/^\((?:\d+|99\+)\)\s+/, "");
      originalRef.current = stripped.length > 0 ? stripped : base;
    }
    document.title = formatTabTitle(originalRef.current, pendingCount);
  }, [pendingCount, base]);

  useEffect(() => {
    return () => {
      if (originalRef.current) document.title = originalRef.current;
    };
  }, []);
}
