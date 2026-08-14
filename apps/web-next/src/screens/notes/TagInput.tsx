/**
 * TagInput — chip input for the note composer's tag field. Pure model in
 * tag-input-model.ts; this file is rendering and key handling only.
 *
 * Does not fetch. `suggestions` is the project's tag list, passed in by the
 * composer (the result of the existing `notes.tags(project_id)` client
 * call), so this component stays reusable and testable without a network
 * dependency.
 *
 * Chips are uncoloured: this screen never uses colour to mark a
 * configuration fact, so a tag chip looks the same whether it is old or new,
 * short or long. Field padding, radius, border and font sizes are copied
 * from apps/web-next/src/components/ListSearchField.tsx (the bordered-field
 * reference); the chip shape and mono type are copied from the neutral
 * (inactive) tag chip in apps/web-next/src/screens/notes/Notes.tsx, which is
 * this app's existing uncoloured tag chip; the suggestion dropdown shell
 * (glass background, blur, shadow, row hover) is copied from
 * apps/web-next/src/screens/inbox/detail/fields/SelectField.tsx.
 *
 * Escape cancels the nearest thing, once: the first Escape closes the
 * suggestion dropdown and stops propagation, so it does not also drop the
 * app shell out of zen mode. The guard for that is `tagDropdownVisible`, the
 * same boolean that gates rendering the dropdown, not the raw `open` flag —
 * `open` goes true on a bare focus before anything is rendered, and gating
 * Escape on it swallowed a keypress with nothing on screen to close. With
 * the dropdown not visible, Escape is not handled here and reaches the
 * composer for its own cancel behaviour.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  canAddTag,
  normaliseTag,
  suggestTags,
  tagDropdownVisible,
  tagFieldLayout,
  TAGS_MAX,
} from "./tag-input-model";

export function TagInput({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = normaliseTag(typed);
  const matches = suggestTags(suggestions, value, typed);
  const canCreate = query.length > 0 && !suggestions.includes(query) && !value.includes(query);
  // Single source of truth, shared with the Escape handler below: whatever
  // decides the dropdown is on screen is exactly what decides Escape closes
  // it, so a bare focus (open === true, nothing rendered) never eats a
  // keypress with nothing to show for it.
  const showDropdown = tagDropdownVisible(suggestions, value, typed, open);
  const showCount = value.length >= TAGS_MAX - 2;
  const layout = tagFieldLayout(value.length);

  // The chip row no longer wraps (tag-input-model
  // .ts's tagFieldLayout), so once enough tags exist to overflow the
  // column's width, the just-committed or just-focused input can end up
  // scrolled out of view within the row. `inline: "nearest"` scrolls only
  // the row itself just far enough to bring the input back on screen —
  // never the page, and never further than needed — so a tag lands and the
  // cursor stays exactly where the author is typing next.
  useEffect(() => {
    inputRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [value.length]);

  function commit(candidate: string) {
    const t = normaliseTag(candidate);
    if (!canAddTag(value, t)) return;
    onChange([...value, t]);
    setTyped("");
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  return (
    <div className="relative">
      <div
        // `flexWrap` is read from `layout.wrap`
        // (tag-input-model.ts's tagFieldLayout), not a hardcoded
        // `flex-nowrap` class — the pure function tag-input-model.test.ts
        // pins is the actual thing driving the row, not a decoration beside
        // it. `overflow-x-auto` stays a plain class: it is about scrolling,
        // not the wrap decision the tests cover. Chips scroll sideways
        // instead of wrapping, so this row can only ever be one line tall.
        // The scrollbar itself needs no per-component styling: tokens.css's
        // `::-webkit-scrollbar` rules key visibility on
        // `[data-gw-scrolling]`, stamped by theme/scroll-reveal.ts's
        // document-level scroll listener on WHATEVER element is actually
        // scrolling — the same "invisible at rest, a thin thumb only while
        // scrolling" rule every other scroll container in this app already
        // gets for free, just by being `overflow-x-auto`/`overflow-y-auto`.
        className="flex items-center overflow-x-auto rounded-[9px]"
        style={{
          gap: 7,
          padding: "9px 11px",
          minHeight: layout.height,
          flexWrap: layout.wrap,
          background: "rgba(var(--gw-hi-rgb),.03)",
          border: "1px solid rgba(var(--gw-line-rgb),.09)",
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag) => (
          <span
            key={tag}
            // shrink-0: a nowrap row's default flex-shrink would squeeze
            // chip text to fit instead of actually overflowing — the row
            // needs to overflow so overflow-x-auto has something to scroll.
            className="inline-flex shrink-0 items-center font-mono"
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
            #{tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              aria-label={`Remove tag ${tag}`}
              className="flex cursor-pointer border-none bg-transparent p-0 text-inherit"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (!showDropdown) return;
              e.stopPropagation();
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === "Enter" || e.key === ",") {
              if (!query) return;
              e.preventDefault();
              commit(typed);
              return;
            }
            if (e.key === "Backspace" && typed === "" && value.length > 0) {
              removeTag(value[value.length - 1]);
            }
          }}
          placeholder={value.length === 0 ? "Add tags" : undefined}
          aria-label="Add tag"
          // grow (fills remaining space when chips leave room) + shrink-0
          // (never squeezed below min-w-[80px] — the row overflows and
          // scrolls instead, same reason the chips above are shrink-0).
          className="min-w-[80px] grow shrink-0 bg-transparent text-[13px] text-t2 outline-none placeholder:text-t8"
          style={{ border: "none", fontFamily: "inherit" }}
        />
      </div>

      {/* Fix round 3: always rendered (never conditionally removed), so the
          count row's own space is permanently reserved and A_NOTE_CAN below
          it does not shift down by ~20px the moment `showCount` flips true
          near the cap — the same "reserve the layout space regardless of
          which state is showing" rule this round's tag-box height fix
          already applies, just via `visibility` here since there is
          nothing to float above in an EMPTY state the way a chip does. */}
      <div
        className="mt-1 text-right font-mono text-[11px] text-t8"
        style={{ visibility: showCount ? "visible" : "hidden" }}
      >
        {value.length}/{TAGS_MAX}
      </div>

      {showDropdown && (
        <>
          <div className="fixed inset-0 z-[39]" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 z-[40] flex flex-col"
            style={{
              top: "calc(100% + 5px)",
              minWidth: 172,
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
            {matches.map((tag) => (
              <button
                key={tag}
                type="button"
                className="flex w-full cursor-pointer items-center border-none text-left font-mono text-[12px] transition-colors"
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--gw-t4)",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.06)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={() => commit(tag)}
              >
                #{tag}
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                className="flex w-full cursor-pointer items-center border-none text-left font-mono text-[12px] transition-colors"
                style={{
                  padding: "7px 10px",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--gw-t4)",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(var(--gw-line-rgb),.06)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={() => commit(query)}
              >
                create #{query}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
