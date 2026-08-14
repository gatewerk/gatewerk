/**
 * The one breakpoint in web-next. Below it the app shows one pane at a time
 * with a bottom tab bar, at or above it the desktop shell with its icon rail
 * and side by side panes.
 *
 * The number is 1120 because that is what the desktop layout has always said
 * it needs: AppShell carried `min-w-[1120px]` long before any of this, and the
 * list, payload and rail widths underneath it add up to that. It is not a
 * guess about devices.
 *
 * It was 768 for exactly one afternoon, and that was wrong. At 834, an iPad in
 * portrait, the shell still measured 1120 and 286px of the app hung off the
 * right edge, clipped rather than scrollable because two ancestors carry
 * overflow-hidden. Anything between 768 and 1119 had the same bug the phone
 * layout was written to fix. Setting the breakpoint to the layout's own
 * declared floor means no width is ever served a layout that does not fit.
 *
 * The cost is that a landscape tablet gets a wide single column instead of two
 * panes. That is a worse use of the space and a better use of the screen than
 * hiding a quarter of it.
 *
 * isNarrowWidth fails to WIDE for a nonsense width (0, NaN). A bad measurement
 * should land a reviewer on the full app, which merely looks cramped, rather
 * than on the phone layout on a desktop, which looks broken.
 */
export const NARROW_MAX_WIDTH = 1120;

export const NARROW_MEDIA_QUERY = `(max-width: ${NARROW_MAX_WIDTH - 1}px)`;

export function isNarrowWidth(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  return width < NARROW_MAX_WIDTH;
}
