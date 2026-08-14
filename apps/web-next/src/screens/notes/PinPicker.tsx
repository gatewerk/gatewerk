/**
 * PinPicker — dropdown that pins a note to a template, used by the note
 * composer.
 *
 * Pinning is templates only. This used to search
 * reviews and templates by free text; that fetching, searching and the
 * picker's 50-review search window are gone along with it — see
 * pin-picker-model.ts's file comment for the reasoning and for why "review"
 * and "chain_run" still exist in PinTarget. A workspace has few templates
 * and many reviews, so the control is a closed dropdown rather than a
 * type-to-search box: trigger chip and dropdown shell are copied from
 * apps/web-next/src/screens/inbox/detail/fields/SelectField.tsx (chip:
 * lines 27-62; dropdown shell: lines 79-96). The removable-chip treatment
 * above the trigger is unchanged from before this ruling.
 *
 * Templates are fetched under the SAME query key the rest of the app
 * already reads and invalidates, not a private picker key, so a template
 * that arrives while the composer is open becomes pinnable without the
 * picker having to unmount and remount: TEMPLATES_QUERY_KEY (`["templates"]`)
 * exported from apps/web-next/src/screens/templates/Templates.tsx, the same
 * key TemplateDetail.tsx invalidates on every create/update/publish/delete.
 *
 * Escape cancels the nearest thing, once: the first Escape closes the
 * dropdown and stops propagation, so it does not also drop the app shell
 * out of zen mode. The guard for that is `pinDropdownVisible`, the same
 * boolean that gates rendering the dropdown, not the raw `open` flag —
 * `open` goes true on a bare click before the templates query may have
 * settled, which is a state with nothing rendered yet.
 */
import { useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { templates } from "@gatewerk/web-core/api/templates";
import { TEMPLATES_QUERY_KEY } from "~/screens/templates/Templates";
import { availableTargets, pinDropdownVisible, PINS_MAX, targetsFromLists, type PinTarget } from "./pin-picker-model";

export function PinPicker({
  value,
  onChange,
}: {
  value: PinTarget[];
  onChange: (targets: PinTarget[]) => void;
}) {
  const [open, setOpen] = useState(false);

  const templatesQuery = useQuery({ queryKey: TEMPLATES_QUERY_KEY, queryFn: templates.list });
  const isLoading = templatesQuery.isLoading;

  const targets = useMemo(
    () => targetsFromLists(templatesQuery.data?.items ?? []),
    [templatesQuery.data],
  );

  const atCap = value.length >= PINS_MAX;
  const options = atCap ? [] : availableTargets(targets, value);
  // Single source of truth, shared with the Escape handler below: whatever
  // decides the dropdown is on screen is exactly what decides Escape closes
  // it.
  const showDropdown = pinDropdownVisible(open, isLoading);

  function commit(target: PinTarget) {
    onChange([...value, target]);
    setOpen(false);
  }

  function remove(target: PinTarget) {
    onChange(value.filter((t) => !(t.kind === target.kind && t.id === target.id)));
  }

  return (
    <div className="relative">
      {value.length > 0 && (
        <div className="flex flex-wrap items-center" style={{ gap: 7, marginBottom: 7 }}>
          {value.map((t) => (
            <span
              key={`${t.kind}:${t.id}`}
              className="inline-flex items-center font-mono"
              style={{
                gap: 5,
                padding: "4px 9px",
                borderRadius: 7,
                fontSize: 11,
                background: "rgba(var(--gw-line-rgb),.04)",
                color: "var(--gw-t6)",
                border: "1px solid rgba(var(--gw-line-rgb),.09)",
              }}
            >
              {t.label}
              <button
                type="button"
                onClick={() => remove(t)}
                aria-label={`Remove ${t.label}`}
                className="flex cursor-pointer border-none bg-transparent p-0 text-inherit"
              >
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Trigger — SelectField.tsx's editable chip button (lines 27-75),
          closed rather than a free-text field. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (!showDropdown) return;
          e.stopPropagation();
          e.preventDefault();
          setOpen(false);
        }}
        disabled={atCap}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Pin a template"
        className="cursor-pointer border-none bg-transparent p-0 disabled:cursor-not-allowed"
        style={{ appearance: "none", fontFamily: "inherit" }}
      >
        <span
          className="inline-flex items-center text-[13px]"
          style={{
            gap: 7,
            color: "var(--gw-t3)",
            background: "rgba(var(--gw-line-rgb),.05)",
            border: "1px solid rgba(var(--gw-line-rgb),.12)",
            borderRadius: 7,
            padding: "4px 11px",
            opacity: atCap ? 0.5 : 1,
          }}
        >
          Pin a template
          <ChevronDown
            size={12}
            strokeWidth={2}
            style={{
              color: "var(--gw-t8)",
              transition: "transform .15s",
              transform: open ? "rotate(180deg)" : undefined,
            }}
          />
        </span>
      </button>

      {atCap && (
        <div className="mt-1 text-[11px] text-t8">{PINS_MAX} pinned is the most a note can carry.</div>
      )}

      {showDropdown && (
        <>
          <div className="fixed inset-0 z-[39]" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            aria-label="Templates"
            className="absolute left-0 z-[40] flex flex-col"
            style={{
              top: "calc(100% + 5px)",
              minWidth: 220,
              gap: 1,
              padding: 5,
              background: "rgba(var(--gw-glass-rgb),.74)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
              border: "1px solid rgba(var(--gw-line-rgb),.14)",
              borderRadius: 9,
              boxShadow: "0 14px 36px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {options.length === 0 ? (
              <div className="px-[10px] py-[7px] text-[12px] text-t8">
                {targets.length === 0 ? "No templates yet" : "Every template is already pinned"}
              </div>
            ) : (
              options.map((t) => (
                <button
                  key={`${t.kind}:${t.id}`}
                  type="button"
                  role="option"
                  className="flex w-full cursor-pointer items-center border-none text-left transition-colors"
                  style={{
                    gap: 9,
                    padding: "7px 10px",
                    borderRadius: 6,
                    background: "transparent",
                    fontFamily: "inherit",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.06)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  onClick={() => commit(t)}
                >
                  <span className="truncate text-[13px] text-t4">{t.label}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
