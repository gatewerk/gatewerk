/**
 * Scroll-activated scrollbar reveal. One capture-phase listener on document
 * (scroll events do not bubble, but they do capture) stamps
 * `data-gw-scrolling` on whatever element is scrolling and removes it shortly
 * after the last scroll event. tokens.css keys the thumb's visibility on that
 * attribute, which is what makes the bar appear only during an actual scroll —
 * the overlay-scrollbar behavior custom ::-webkit-scrollbar styling otherwise
 * disables.
 */

const LINGER_MS = 700;

let installed = false;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

export function initScrollReveal(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      el.setAttribute("data-gw-scrolling", "");
      const prior = timers.get(el);
      if (prior !== undefined) clearTimeout(prior);
      timers.set(
        el,
        setTimeout(() => {
          el.removeAttribute("data-gw-scrolling");
          timers.delete(el);
        }, LINGER_MS),
      );
    },
    { capture: true, passive: true },
  );
}
