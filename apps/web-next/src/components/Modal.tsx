/**
 * Shared modal chrome — backdrop, centered card, Escape-to-close via the
 * shared escape-layer stack (see escape-layers.ts) — an open popover inside
 * the modal claims Escape first, click-outside-to-close. Extracted from
 * templates/detail's ActionModal and settings/account's PasswordModal, which
 * had grown three near-identical copies of this exact backdrop/card block
 * (ApiKeysPane and WebhooksPane's create/edit forms are the third and
 * fourth). ActionModal and PasswordModal migrated onto this component,
 * completing the extraction.
 *
 * `closeOnBackdrop`/`closeOnEscape` default to true but exist for content
 * where an accidental dismiss is costly — a reveal-once secret, say, where a
 * stray click just outside the card should not be how it disappears forever.
 *
 * Optional `title` renders in the reserved header zone as a real `<h2>` that
 * names the dialog via `aria-labelledby` — the feedback modal's hoist
 * recipe, internalized. Without a title, `aria-label` names it instead.
 * Optional `subtitle` renders under the title using the shared recipe.
 *
 * Focus is trapped while open and restored on close.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useEscapeLayer } from "./escape-layers";

export function Modal({
  onClose,
  ariaLabel,
  title,
  subtitle,
  width = 420,
  closeOnBackdrop = true,
  closeOnEscape = true,
  children,
}: {
  onClose: () => void;
  ariaLabel: string;
  title?: string;
  subtitle?: string;
  width?: number;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  children: ReactNode;
}) {
  useEscapeLayer(closeOnEscape, onClose);
  const titleId = useId();

  // Focus trap: Tab cycles inside the card; focus returns to the opener on
  // close. Initial focus goes to the card itself UNLESS content brought its
  // own autoFocus — forms like InviteForm open with a focused input and the
  // trap must not steal it.
  const cardRef = useRef<HTMLDivElement>(null);
  // Captured at render time, not in an effect: passive effects run AFTER
  // React applies commit-time autoFocus, so by the time a passive effect
  // reads document.activeElement, autofocusing content (e.g. InviteForm's
  // email input) has already stolen it — capturing there would "restore"
  // focus to the modal's own input instead of the real opener.
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (!card.contains(document.activeElement)) card.focus();

    function focusables(): HTMLElement[] {
      return Array.from(
        card!.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const els = focusables();
      if (els.length === 0) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }

    card.addEventListener("keydown", onKey);
    return () => {
      card.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,.5)" }}
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : ariaLabel}
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full flex-col gap-5"
        style={{
          maxWidth: width,
          maxHeight: "85vh",
          overflowY: "auto",
          // Top padding clears the close button's own footprint (top:14 +
          // 28px tall + a little air) rather than matching the other three
          // sides — content here routinely opens with a full-width SectionRule
          // hairline (ApiKeyForm, WebhookForm, RevealedKeyPanel all do), and
          // at an even p-6 that hairline sat in the same row as the button
          // and visibly crossed through it.
          padding: "50px 24px 24px",
          // The focus trap (above) moves focus onto this card via
          // card.focus() with tabIndex=-1 — a non-interactive container, not
          // a control. Chromium's :focus-visible heuristic still paints its
          // default blue outline around it when the modal opens right after
          // a keyboard interaction. Suppressing it here is accessibility-
          // neutral: Tab still lands on real controls, which keep their own
          // gw-focus-ring.
          outline: "none",
          background: "rgba(var(--gw-modal-rgb),.98)",
          border: "1px solid rgba(var(--gw-line-rgb),.14)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(var(--gw-line-rgb),.08)",
        }}
      >
        <button
          type="button"
          title="Close"
          aria-label="Close"
          onClick={onClose}
          className="gw-focus-ring absolute flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
          style={{ top: 14, right: 14, color: "var(--gw-t8)" }}
        >
          <X size={14} />
        </button>
        {title && (
          <div className="pr-8" style={{ marginTop: -30 }}>
            <h2 id={titleId} className="text-[15px] font-semibold text-t1">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--gw-t6)" }}>
                {subtitle}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
