/**
 * Settings grammar kit — the Redesign.dc.html prototype's Settings language,
 * measured from the design manifest (§2.0-2.9), not re-derived.
 *
 * Rulings reconciled below (newest wins, so the
 * values don't read as drift):
 * - Toggles stay NEUTRAL-ON (the prototype's green toggles lose to the
 *   standing green-is-the-affirmative ruling) — Toggle.tsx is unchanged.
 * - Section-header primary actions (New key, New webhook) ARE green pills,
 *   per the prototype (the one green primary per pane).
 * - Meta lines stay lowercase mono SPACE separated (the prototype's pipes
 *   and middots lose to the standing separator ruling).
 */
import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";

/**
 * Filter input/select shell (manifest S6.1): inset bg, hairline border,
 * radius 9, padding 8px/11px, border brightens on focus. Expressed entirely
 * as Tailwind classes (not an inline `style` object) so `focus:` can win —
 * an inline-style `border` always beats a stylesheet rule, which is exactly
 * why INSET_INPUT_CLASS abandoned border-based focus elsewhere.
 *
 * Promoted here from ActivityPane when Deliveries grew its own date-range
 * filter in the same shape — one shared class, not two copies to keep in
 * sync.
 */
export const FILTER_CONTROL_CLASS =
  "gw-focus-ring w-full rounded-[9px] border border-[rgba(var(--gw-line-rgb),0.1)] bg-[var(--gw-inset)] px-[11px] py-2 text-[12px] text-[var(--gw-t2)] outline-none transition-colors focus:border-[rgba(var(--gw-line-rgb),0.28)]";

/** Labeled filter control: small mono uppercase eyebrow above whatever
 *  input/select/menu it wraps (Activity's Action/Resource type/Date range,
 *  and Deliveries' own Date range). */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-[140px] flex-1 flex-col">
      <span
        className="mb-1.5 font-mono text-[9px] font-semibold uppercase"
        style={{ letterSpacing: ".08em", color: "var(--gw-t9)" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * Multi-select filter dropdown: search box + checklist, trigger reading
 * "All X" / the one label / "N nouns selected". Promoted here from
 * ActivityPane's ActionFilterMenu (the Action filter, 50+ values) when
 * Deliveries grew an Event type filter in the same shape — one shared
 * component, not two copies to keep in sync, same reasoning
 * FILTER_CONTROL_CLASS above already went through.
 *
 * `mono` controls the trigger's single-selected-value display and the
 * checklist rows' font: Activity's actions are literal snake.case strings
 * (mono reads right), Deliveries' events have human labels ("Review
 * created") that read better in the UI's normal text face.
 */
export function MultiSelectFilterMenu({
  value,
  onChange,
  options,
  allLabel,
  pluralNoun,
  ariaLabel,
  searchPlaceholder,
  mono = false,
  minWidth = 0,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: readonly MultiSelectOption[];
  /** Trigger text when nothing is selected, e.g. "All actions". */
  allLabel: string;
  /** Plural noun for "{n} {pluralNoun} selected", e.g. "actions". */
  pluralNoun: string;
  ariaLabel: string;
  searchPlaceholder: string;
  mono?: boolean;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Not a `fixed inset-0` click-catcher div: `position: fixed` escapes
    // z-index comparison against this menu's own `position: absolute`
    // whenever no ancestor traps it with a transform/filter/etc, so that
    // div painted ABOVE this menu instead of behind it — every option was
    // visible but unclickable (same defect fixed in templates/_ui.tsx's
    // SelectMenu, same reason). A document-level listener has no z-index
    // to get wrong.
    function onOutsideClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick, true);
    return () => document.removeEventListener("mousedown", onOutsideClick, true);
  }, [open]);

  function toggle(optionValue: string) {
    onChange(value.includes(optionValue) ? value.filter((v) => v !== optionValue) : [...value, optionValue]);
  }

  const q = query.trim().toLowerCase();
  const filtered = options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
  );
  const selectedLabel = value.length === 1 ? (options.find((o) => o.value === value[0])?.label ?? value[0]) : "";
  const label =
    value.length === 0 ? allLabel : value.length === 1 ? selectedLabel : `${value.length} ${pluralNoun} selected`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={`${FILTER_CONTROL_CLASS} flex cursor-pointer items-center justify-between gap-2`}
        style={{ minWidth }}
      >
        <span
          className={`truncate ${value.length === 1 && mono ? "font-mono" : ""}`}
          style={{ color: value.length === 0 ? "var(--gw-t8)" : "var(--gw-t2)" }}
        >
          {label}
        </span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0" style={{ color: "var(--gw-t8)" }} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-[40] mt-1 flex flex-col"
          style={{
            width: 280,
            background: "rgba(var(--gw-modal-rgb),.96)",
            backdropFilter: "blur(18px) saturate(140%)",
            WebkitBackdropFilter: "blur(18px) saturate(140%)",
            border: "1px solid rgba(var(--gw-line-rgb),.14)",
            borderRadius: 11,
            boxShadow: "0 18px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
            overflow: "hidden",
          }}
        >
          <div
            className="flex items-center gap-2 px-2.5 py-2"
            style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.1)" }}
          >
            <Search size={13} strokeWidth={1.8} className="shrink-0" style={{ color: "var(--gw-t8)" }} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-t9"
              style={{ color: "var(--gw-t2)", fontFamily: "inherit", border: "none" }}
            />
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11px] font-medium"
                style={{ color: "var(--gw-blue-t)" }}
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-col gap-px overflow-y-auto p-1.5" style={{ maxHeight: 280 }}>
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-[11.5px]" style={{ color: "var(--gw-t8)" }}>
                No matches
              </p>
            ) : (
              filtered.map((option) => {
                const on = value.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={on}
                    onClick={() => toggle(option.value)}
                    className={`flex w-full cursor-pointer items-center gap-[9px] rounded-[7px] border-none bg-transparent px-2.5 py-[7px] text-left text-[11.5px] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] ${mono ? "font-mono" : ""}`}
                    style={{ color: on ? "var(--gw-t2)" : "var(--gw-t5)" }}
                  >
                    <span
                      className="flex shrink-0 items-center justify-center"
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: 4,
                        border: on ? "1.5px solid var(--gw-t3)" : "1.5px solid rgba(var(--gw-line-rgb),.24)",
                        background: on ? "var(--gw-t3)" : "transparent",
                      }}
                    >
                      {on && <Check size={9} strokeWidth={3} style={{ color: "var(--gw-green-ink)" }} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Pane title block: Bricolage 24/600 + 13.5 subtitle (manifest S0.11-S0.12). */
export function PaneHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1
        className="m-0 text-[24px] font-semibold"
        style={{
          fontFamily: "var(--font-display)",
          letterSpacing: "-.02em",
          color: "var(--gw-t1)",
        }}
      >
        {title}
      </h1>
      <p className="m-0 mt-1.5 text-[13.5px]" style={{ color: "var(--gw-t7)" }}>
        {subtitle}
      </p>
    </div>
  );
}

/**
 * Section rule: mono uppercase label + hairline + optional right action
 * (manifest S3.1/S4.5/S5.2). The right slot is where the pane's one green
 * primary lives.
 */
export function SectionRule({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className="shrink-0 font-mono text-[10.5px] font-semibold uppercase"
        style={{ letterSpacing: ".16em", color: "var(--gw-t8)" }}
      >
        {label}
      </span>
      <div className="h-px flex-1" style={{ background: "rgba(var(--gw-line-rgb),.07)" }} />
      {right}
    </div>
  );
}

/** The green primary pill (manifest S3.1: 12/600 ink-on-green, radius 8). */
export function GreenPill({
  children,
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="gw-focus-ring shrink-0 cursor-pointer rounded-[8px] border-none px-[11px] py-[5px] text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: "var(--gw-green)", color: "var(--gw-green-ink)" }}
    >
      {children}
    </button>
  );
}

/**
 * Blue text action, the row-level affordance (manifest S1.6).
 *
 * `disabled` renders it inert and dimmed rather than unmounting it — a row
 * whose Edit link vanishes outright while a sibling row is being edited
 * reads as the affordance being gone, not locked, and the row's own width
 * jumps when the slot empties. Project's rows now pass `disabled` instead.
 */
export function ActionLink({
  children,
  onClick,
  ariaLabel,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="gw-focus-ring shrink-0 cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed"
      style={{ color: disabled ? "var(--gw-t8)" : "var(--gw-blue-t)" }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.color = "var(--gw-blue-h)";
      }}
      onMouseLeave={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.color = "var(--gw-blue-t)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Flat hairline row: fixed label column, flexible value, right action slot
 * (manifest S1.6/S2.1). `labelWidth` is 130 on Account, 150 on Project.
 */
export function SettingsRow({
  label,
  labelWidth = 130,
  mono = false,
  action,
  /** False for the last row of a flat group (manifest's own isLast rule —
   *  NotificationsPane's matrix rows drop the same trailing hairline). */
  divider = true,
  /**
   * When set, the value itself is the affordance — click it to edit or
   * copy — instead of a separate blue ActionLink doing the same thing next
   * to it. A plain clickable value has no visible cue that it does
   * anything, so this always pairs with `onValueClickIcon`: a hover tint
   * across the value plus that icon fading in at its trailing edge is what
   * makes the click discoverable rather than a secret.
   */
  onValueClick,
  onValueClickIcon,
  onValueClickLabel,
  children,
}: {
  label: string;
  labelWidth?: number;
  /** Value renders JetBrains mono 12.5 when true (Project's values). */
  mono?: boolean;
  action?: ReactNode;
  divider?: boolean;
  onValueClick?: () => void;
  onValueClickIcon?: ReactNode;
  onValueClickLabel?: string;
  children: ReactNode;
}) {
  const valueClass = `min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${mono ? "font-mono text-[12.5px]" : "text-[13px]"}`;

  return (
    <div
      className="flex items-center gap-3 px-0.5 py-3.5"
      style={{ borderBottom: divider ? "1px solid rgba(var(--gw-line-rgb),.06)" : "none" }}
    >
      <span className="shrink-0 text-[13px]" style={{ width: labelWidth, color: "var(--gw-t6)" }}>
        {label}
      </span>
      {onValueClick ? (
        <button
          type="button"
          onClick={onValueClick}
          aria-label={onValueClickLabel}
          className="group gw-focus-ring -my-1.5 -ml-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[7px] border-none bg-transparent py-1.5 pl-2 text-left transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.05)]"
        >
          <span className={valueClass} style={{ color: "var(--gw-t3)" }}>
            {children}
          </span>
          <span
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: "var(--gw-t8)" }}
          >
            {onValueClickIcon}
          </span>
        </button>
      ) : (
        <div className={valueClass} style={{ color: "var(--gw-t3)" }}>
          {children}
        </div>
      )}
      {action}
    </div>
  );
}

/**
 * A SettingsRow's value, pinned to one fixed height whether it's showing
 * plain text or has swapped in an inline edit control (RowTextInput +
 * RowSaveCancel). Without this, entering edit mode changes the row's own
 * height — Account's Name row did this before it was fixed, and it jumped
 * every row below it down, then jumped them back up on Cancel/Save.
 *
 * One shared constant, not a per-pane guess: Account and Project's inline
 * edit rows both use it, so a row here is never a different height than an
 * otherwise-identical row two panes over.
 */
export const ROW_CONTENT_HEIGHT = 28;

export function RowValue({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap"
      style={{ height: ROW_CONTENT_HEIGHT }}
    >
      {children}
    </div>
  );
}

/**
 * Inline text-edit input for a SettingsRow value. A soft border-color +
 * diffuse box-shadow glow on focus (the auth screens' own FocusInput
 * language), not `.gw-focus-ring`'s harder-edged ring — stacked on top of
 * this input's own border, the crisp ring read as a doubled, uneven-looking
 * outline rather than one clean focus state.
 */
export function RowTextInput({
  width = "100%",
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { width?: number | string }) {
  return (
    <input
      {...props}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.3)";
        e.currentTarget.style.boxShadow = "0 0 0 3px rgba(var(--gw-line-rgb),.06)";
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "rgba(var(--gw-line-rgb),.12)";
        e.currentTarget.style.boxShadow = "none";
        props.onBlur?.(e);
      }}
      style={{
        height: ROW_CONTENT_HEIGHT,
        width,
        borderRadius: 8,
        padding: "0 10px",
        background: "var(--gw-inset)",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "rgba(var(--gw-line-rgb),.12)",
        boxShadow: "none",
        color: "var(--gw-t2)",
        fontSize: 12.5,
        outline: "none",
        fontFamily: "inherit",
        transition: "border-color .12s, box-shadow .12s",
        ...style,
      }}
    />
  );
}

/**
 * Save/Cancel pair for a SettingsRow's inline edit: a filled pill for Save
 * (the same weight as the Activity filter bar's Apply button — a save
 * action reads as a real button, not a blue text link doing double duty as
 * label and control) and a quiet ghost Cancel. Both pinned to
 * ROW_CONTENT_HEIGHT so the row never resizes when they appear.
 */
export function RowSaveCancel({
  onSave,
  onCancel,
  saving = false,
  saveDisabled = false,
}: {
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        disabled={saving || saveDisabled}
        onClick={onSave}
        className="gw-focus-ring flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] border-none bg-[rgba(var(--gw-line-rgb),0.08)] px-3 text-[12px] font-medium text-[var(--gw-t3)] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.13)] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ height: ROW_CONTENT_HEIGHT }}
      >
        {saving && <Loader2 size={11} className="animate-spin" />}
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="gw-focus-ring flex shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none bg-transparent px-2.5 text-[12px] font-medium text-[var(--gw-t7)] transition-colors hover:text-[var(--gw-t4)]"
        style={{ height: ROW_CONTENT_HEIGHT }}
      >
        Cancel
      </button>
    </div>
  );
}

/** Inset card shell (manifest S1.1/S9.1: border .08, radius 14, inset-soft). */
export const CARD_SHELL: CSSProperties = {
  border: "1px solid rgba(var(--gw-line-rgb),.08)",
  borderRadius: 14,
  background: "var(--gw-inset-soft)",
  padding: "16px 18px",
};

/** Danger card shell (manifest S9.6). */
export const DANGER_SHELL: CSSProperties = {
  border: "1px solid rgba(var(--gw-red-rgb),.24)",
  borderRadius: 14,
  background: "rgba(var(--gw-red-rgb),.05)",
  padding: "15px 18px",
};

/** Copyable info chip (manifest S4.1: API Keys' Base URL / Project ID / Protocol). */
export const INFO_CARD: CSSProperties = {
  border: "1px solid rgba(var(--gw-line-rgb),.08)",
  borderRadius: 11,
  background: "var(--gw-inset-soft)",
  padding: "11px 13px",
};
