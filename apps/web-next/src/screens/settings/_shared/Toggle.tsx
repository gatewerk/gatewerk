/**
 * Toggle — accessible switch button using web-next theme tokens.
 *
 * Track:  on  = rgba(var(--gw-line-rgb),.45) — NEUTRAL, not green.
 *         Green marks the affirmative (a decision taken, or
 *         the action that commits); a toggle's on-state is neither.
 *         off = var(--gw-panel-b)  (bg-panel-b)
 * Thumb:  var(--gw-panel-a), 14x14, translates 2px (off) / 16px (on). Not
 *         white and not a t-token — panel-a keeps contrast against the ink
 *         track in BOTH themes (t2/white invert badly under html.gw-light).
 * Size: 18px tall × 32px wide (spec match for old-web Toggle).
 */

export function Toggle({
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className="relative inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        background: checked
          ? "rgba(var(--gw-line-rgb),.45)"
          : "var(--gw-panel-b)",
        boxShadow: checked
          ? "none"
          : "inset 0 0 0 1px rgba(var(--gw-line-rgb),.18)",
      }}
    >
      <span
        className="pointer-events-none inline-block h-[14px] w-[14px] rounded-full shadow-sm transition-transform duration-200"
        style={{
          background: "var(--gw-panel-a)",
          transform: checked ? "translateX(16px)" : "translateX(2px)",
        }}
      />
    </button>
  );
}
