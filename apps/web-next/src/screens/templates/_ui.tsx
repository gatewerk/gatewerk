/**
 * Shared primitives for the Templates screen, in web-next's design language.
 *
 * These are rewritten rather than imported from apps/web for a build reason,
 * not a taste one: web-next's `tokens.css` is a bare `@import "tailwindcss"`
 * with no `@source` directive, so Tailwind v4's auto-detection never scans
 * `apps/web/src`. Every Tailwind class inside an apps/web component is absent
 * from web-next's generated CSS, and apps/web's shadcn-era semantics
 * (`text-dim`, `bg-card-hover`, `ring-border`) have no token here at all. Pure
 * `.ts` logic crosses the boundary safely; `.tsx` does not.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { RulerTickHeader } from "~/components/RulerTickHeader";
import { INSET_STYLE, INSET_INPUT_CLASS, INSET_TEXTAREA_CLASS } from "../../components/field/field-styles";
import { useEscapeLayer } from "../../components/escape-layers";

export { INSET_STYLE, INSET_INPUT_CLASS, INSET_TEXTAREA_CLASS };

/** Panel-flat card, the surface every section on this screen sits on. */
export const CARD_STYLE = {
  background: "var(--gw-panel-flat)",
  border: "1px solid rgba(var(--gw-line-rgb),.08)",
} as const;

/**
 * Section header for this screen. It is `RulerTickHeader` — the same component
 * the Inbox and History draw, not a fourth restatement of the same eight
 * values, which is how the label width and the end tick drifted in the first
 * place. The wrapper survives only to carry this screen's zero margin (the
 * section's own `flex flex-col gap-4` does the spacing).
 *
 * `rail` is the one distinction the component makes: a narrow column of short
 * blocks gets no end tick, or the ticks read as tally marks.
 */
export function SectionHeader({
  label,
  right,
  className = "",
  rail = false,
}: {
  label: string;
  right?: ReactNode;
  className?: string;
  rail?: boolean;
}) {
  return (
    <RulerTickHeader label={label} right={right} marginClassName={className} endTick={!rail} />
  );
}

/**
 * The empty state for a section slot, in History's language.
 *
 * History's is the reference the doctrine names, and the thing to take from it
 * is that it has NO CONTAINER: an empty room is drawn as an empty room, not as
 * a box with a sentence in it. This screen had three of these and all three
 * disagreed — Fields and Actions were carded single-liners at 12px, Chain was a
 * bordered two-liner at 12.5/11.5, and none of them matched History's 13/12.
 *
 * Two things are NOT borrowed, both for the same reason — History's empty state
 * fills a whole list pane and can afford a moment, while these fill a slot with
 * siblings underneath. Its icon is dropped (the section header has already
 * named the slot), and its py-12 comes down to py-8, which is the difference
 * between Export sitting on the fold and just under it. Everything that carries
 * meaning — no container, 13/t5 over 12/t8, centred, gap-2 — is verbatim.
 */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <p style={{ margin: 0, fontSize: 13, color: "var(--gw-t5)" }}>{title}</p>
      {hint && <p style={{ margin: 0, fontSize: 12, color: "var(--gw-t7)" }}>{hint}</p>}
    </div>
  );
}

/**
 * Row label in the settings and step-card grids.
 *
 * The default width is the inbox's key column verbatim
 * (`screens/inbox/detail/FieldRow.tsx`, "clamp(112px, 22%, 150px) per spec
 * §4"). It was 132 here and 168 in ReadConfig's private copy, so every value
 * on this screen jumped 36px sideways the moment anyone clicked Edit — and
 * neither number was the one the inbox uses to draw the same shape.
 *
 * The numeric `width` stays for the chain step card, whose labels sit in a
 * much narrower card and cannot afford the pane measure.
 */
export function RowLabel({ children, top = false, width }: { children: ReactNode; top?: boolean; width?: number }) {
  return (
    <span
      className={`shrink-0 text-[12px] ${top ? "pt-1.5" : ""}`}
      style={{ width: width ?? "clamp(112px, 22%, 150px)", color: "var(--gw-t6)" }}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  /** Accessible name. Required — a bare switch is unlabelled to a screen reader. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="gw-focus-ring relative h-5 w-9 shrink-0 cursor-pointer rounded-full border-none transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      // Neutral-on, not green-on: green marks the
      // affirmative — a decision taken, or the action that commits — and a
      // toggle's on-state is neither.
      style={{ background: checked ? "rgba(var(--gw-line-rgb),.45)" : "rgba(var(--gw-line-rgb),.20)" }}
    >
      <span
        className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform"
        style={{
          // NOT --gw-t2: that is near-black under html.gw-light, which inverts
          // the knob into a dark pill on a light track. The knob is a physical
          // object, so it stays light in both themes, like the panel surface.
          background: "var(--gw-panel-a)",
          transform: checked ? "translateX(16px)" : "translateX(0)",
          boxShadow: "0 1px 2px rgba(0,0,0,.35)",
        }}
      />
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Chip trigger plus a glass menu.
 *
 * Escape goes through the shared escape-layer stack (see escape-layers.ts),
 * which still claims the event (`preventDefault`) so the editor's own
 * Escape-to-cancel bails on `defaultPrevented`, and so does `useZen`, exactly
 * as before. Without that, one Escape inside an open menu would close the
 * menu, leave edit mode, and drop out of zen at once.
 *
 * The menu itself renders through a portal to `document.body`, not as an
 * `absolute` child of this trigger. A trigger that sits inside a scrolling
 * container — most notably Modal.tsx's own card, which sets `maxHeight: 85vh`
 * + `overflowY: auto` — clips any `position: absolute` descendant to that
 * container's box, so a menu opening near the container's edge got visibly
 * cut off (design-r5-modalfix, Priority in the chain step modal's Advanced
 * section). Portalling escapes that clip entirely; `menuRef` alongside
 * `rootRef` in the outside-click check exists because the portaled DOM node
 * is no longer a descendant of `rootRef` for `.contains()` purposes.
 */
export function SelectMenu({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  align = "left",
  minWidth = 0,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  align?: "left" | "right";
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; bottom: number; left: number; right: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEscapeLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    // Not a `fixed inset-0` click-catcher div: `position: fixed` escapes
    // z-index comparison against this menu's own `position: absolute`
    // whenever no ancestor traps it with a transform/filter/etc (none does
    // here, and adding one to trap it would also shrink the click-catcher
    // down to this trigger's own tiny box, breaking it the other way). A
    // `fixed inset-0` catcher painted ABOVE this menu instead of behind
    // it, silently, so every option was visible but unclickable. A
    // document-level listener has no z-index to get wrong.
    //
    // `menuRef` is checked alongside `rootRef` because the menu itself now
    // portals to `document.body` — it is not a DOM descendant of `rootRef`,
    // so a click on an option would otherwise register as "outside" and
    // close the menu on mousedown, before the option's own click handler
    // ever runs.
    function onOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick, true);
    return () => document.removeEventListener("mousedown", onOutsideClick, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The portaled menu's position is captured once, at open. If an
    // ancestor scrolls (e.g. the modal's own `overflowY: auto` card) the
    // captured coordinates go stale, so close instead of drawing a menu
    // detached from its trigger. Capture phase catches scroll on any
    // ancestor, not just window.
    function onScroll() {
      setOpen(false);
    }
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open && rootRef.current) {
            // Flip upward when there isn't room below for the menu and
            // there's more room above than below. Without this, a trigger
            // near the bottom of a scrollable pane — e.g. Priority, the
            // last field in a chain step's Advanced section — opens a
            // menu that renders almost entirely off-screen.
            //
            // The needed-height estimate uses the real option count
            // (capped at the menu's own 280px `maxHeight`), not a flat
            // 280 guess — a flat guess over-triggers for a short list
            // (e.g. Template's 6 options need ~200px) on a trigger near
            // the TOP of its own card, flipping the menu upward into that
            // card's `overflow: hidden` clip instead of using the room
            // that was genuinely available below.
            //
            // The boundary for "space below" is the nearest `role="dialog"`
            // ancestor's own bottom edge, not just the viewport's. A
            // trigger sitting just above a modal's footer buttons has
            // plenty of window space below it but almost none before the
            // modal's own Cancel/Add step row — measuring against the
            // window alone used to open the menu straight down on top of
            // those buttons instead of flipping up into the empty space
            // above the trigger.
            const rect = rootRef.current.getBoundingClientRect();
            const dialogEl = rootRef.current.closest('[role="dialog"]');
            const boundaryBottom = dialogEl
              ? Math.min(window.innerHeight, dialogEl.getBoundingClientRect().bottom)
              : window.innerHeight;
            const spaceBelow = boundaryBottom - rect.bottom;
            const spaceAbove = rect.top;
            const neededHeight = Math.min(280, options.length * 32 + 14);
            setOpenUpward(spaceBelow < neededHeight && spaceAbove > spaceBelow);
            setAnchorRect({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
          }
          setOpen((o) => !o);
        }}
        className="gw-focus-ring flex h-7 cursor-pointer items-center gap-1.5 rounded-[10px] px-2.5 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        style={{ ...INSET_STYLE, minWidth }}
      >
        <span className="flex-1 text-left">{current?.label ?? value}</span>
        <ChevronDown size={12} strokeWidth={2} style={{ color: "var(--gw-t8)" }} />
      </button>

      {open &&
        anchorRect &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            // z-[90]: above Modal.tsx's z-[60] card and NavDrawer's z-[81],
            // the two highest layers in this app — the portal reparents the
            // menu to document.body, so it now competes with those layers
            // directly on z-index rather than inheriting a safe stacking
            // position from its old DOM nesting under the trigger.
            className="fixed z-[90] flex flex-col gap-px p-1.5"
            style={{
              ...(openUpward
                ? { bottom: window.innerHeight - anchorRect.top + 4 }
                : { top: anchorRect.bottom + 4 }),
              ...(align === "right"
                ? { right: window.innerWidth - anchorRect.right }
                : { left: anchorRect.left }),
              minWidth: Math.max(148, minWidth),
              background: "rgba(var(--gw-modal-rgb),.96)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              borderRadius: 11,
              boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {options.map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="cursor-pointer rounded-[7px] border-none bg-transparent px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                  style={{ color: on ? "var(--gw-t2)" : "var(--gw-t5)", fontWeight: on ? 600 : 400 }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export { PrimaryButton, GhostButton, IconButton } from "../../components/buttons";

/** Text link used by "Add field", "Add option", "Add step". */
export function AddLink({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="gw-focus-ring flex shrink-0 cursor-pointer items-center gap-1.5 border-none bg-transparent text-[11.5px] font-medium transition-colors hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-40"
      style={{ color: "var(--gw-blue-t)" }}
    >
      {children}
    </button>
  );
}
