/** Inset control surface: inputs, chips, option rows. */
export const INSET_STYLE = {
  background: "var(--gw-inset)",
  border: "1px solid rgba(var(--gw-line-rgb),.10)",
  color: "var(--gw-t2)",
} as const;

/**
 * `gw-focus-ring`, not `focus:border-*`. INSET_STYLE sets the `border`
 * shorthand as an inline style, and an inline style beats a stylesheet rule, so
 * a focus:border- class on these inputs is silently dead — the whole screen had
 * no visible focus state at all. The ring is also the project's focus
 * convention: a brightened neutral line, never green.
 */
/**
 * Matches Settings' filter-box sizing (`settings/_shared/ui.tsx`'s
 * `FILTER_CONTROL_CLASS`) so a single-line input reads the same height and
 * padding whether it's a filter chip or a form field. Colour still comes
 * from `INSET_STYLE`, applied alongside this as an inline style.
 */
export const INSET_INPUT_CLASS =
  "gw-focus-ring rounded-[9px] px-[11px] py-2 text-[12px] outline-none transition-colors placeholder:text-t10";

/** Textarea variant of the above — same box model, multi-line leading. */
export const INSET_TEXTAREA_CLASS =
  "gw-focus-ring w-full resize-none rounded-[9px] px-[11px] py-2 text-[12px] leading-relaxed outline-none transition-colors placeholder:text-t10";
