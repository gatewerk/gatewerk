/**
 * escape-layers — the one Escape dispatcher for stacked dismissable UI
 * (modals, popovers, menus). Before this, every layer registered its own
 * document-capture keydown and the WINNER was whoever registered first —
 * a Modal always mounts before the menu inside it opens, so Escape in an
 * open SelectMenu closed the whole modal. stopPropagation cannot fix that:
 * it does not stop other listeners already queued on the same node.
 *
 * Layers push while open and pop on close; one Escape closes only the
 * topmost layer and claims the event (preventDefault + stopPropagation),
 * which the app's outer Escape cascade — form cancels, useZen — already
 * respects via `defaultPrevented` bails. The document listener attaches
 * only while the stack is non-empty, preserving registration-order
 * behavior relative to capture listeners outside the stack (e.g.
 * TemplateDetail's editor cancel, which also guards on an open dialog).
 *
 * Mount-order invariant: layers push from useEffect, and React runs child
 * effects before parent effects. A layer that mounts already active in the
 * same commit as its enclosing layer would therefore push below it, so
 * Escape would close the outer layer first, which is the exact class of bug
 * this module exists to kill. Every current consumer mounts closed and opens
 * in a later commit, so this cannot happen today; a new consumer that wants
 * to mount already open must do the same, or this module needs explicit
 * z-ordering to stay correct.
 */
import { useEffect, useRef } from "react";

type Layer = { onEscape: () => void };

const layers: Layer[] = [];
let listening = false;

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (!top) return;
  top.onEscape();
  e.preventDefault();
  e.stopPropagation();
}

function sync() {
  if (layers.length > 0 && !listening) {
    document.addEventListener("keydown", onKeydown, true);
    listening = true;
  } else if (layers.length === 0 && listening) {
    document.removeEventListener("keydown", onKeydown, true);
    listening = false;
  }
}

export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { onEscape: () => cb.current() };
    layers.push(layer);
    sync();
    return () => {
      const i = layers.indexOf(layer);
      if (i !== -1) layers.splice(i, 1);
      sync();
    };
  }, [active]);
}
