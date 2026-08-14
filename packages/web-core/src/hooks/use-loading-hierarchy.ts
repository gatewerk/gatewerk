import { useEffect, useState } from "react";

// Loading hierarchy per content-loading spec §4 PR 4:
//   <500ms  → "idle" (don't render anything — avoids flash)
//   500ms   → "loading" (skeleton or progress bar)
//   2s      → "taking_longer" ("Taking longer than usual…" copy)
//   10s     → "struggling" ("Still loading… [Cancel] [Report]")
//
// Consumers read the phase and choose what to render; the hook itself is
// timer-only with no opinion on appearance. Resets on `isLoading` flipping false.
export type LoadingPhase = "idle" | "loading" | "taking_longer" | "struggling";

export function useLoadingHierarchy(isLoading: boolean): LoadingPhase {
  const [phase, setPhase] = useState<LoadingPhase>("idle");

  useEffect(() => {
    if (!isLoading) {
      setPhase("idle");
      return;
    }

    const t1 = setTimeout(() => setPhase("loading"), 500);
    const t2 = setTimeout(() => setPhase("taking_longer"), 2000);
    const t3 = setTimeout(() => setPhase("struggling"), 10000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isLoading]);

  return phase;
}
