import { useSyncExternalStore } from "react";
import { NARROW_MEDIA_QUERY } from "./narrow";

/**
 * True while the viewport is narrower than the breakpoint.
 *
 * useSyncExternalStore rather than useState + useEffect: the first paint reads
 * the real width instead of rendering the desktop shell for one frame and then
 * flipping, which on a phone is a visible 1120px flash.
 *
 * The app is `ssr: false` (see react-router.config.ts), so the server snapshot
 * is only ever used by vitest's jsdom. It returns false, i.e. desktop.
 */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(NARROW_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(NARROW_MEDIA_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
