/**
 * ShortcutsPane — keyboard shortcuts reference for web-next.
 *
 * Read-only, by design. apps/web's version (behavior reference:
 * apps/web/src/pages/settings/shortcuts/ShortcutsPane.tsx) is a full
 * record-a-new-binding UI backed by `@gatewerk/web-core/lib/shortcuts`'s
 * localStorage overrides. web-next does not get that here: of its keydown
 * listeners, only useSlashFocus ("/") actually reads a binding through
 * `getMergedBinding`. useZen's "z", the Escape cascade, and History's
 * arrow-key selection are all hardcoded — recording an override for any of
 * them would write to storage nothing ever reads, a promise this pane cannot
 * make truthfully. So it lists what fires today and nothing more.
 *
 * Every row was verified against a real keydown listener in web-next before
 * being included; the executor report carries the file:line trail. Rows
 * apps/web ships that web-next has not wired — digit navigation (1-5),
 * action letters (a/r/x/e/s/d/n), Inbox/Templates list selection, the "?"
 * overlay, "[" sidebar toggle, "f" feedback focus — are omitted rather than
 * shown as dead promises. Defaults render as silence, not as a longer list.
 */
import type { ReactNode } from "react";
import { SectionRule } from "../_shared/ui";

interface ShortcutItem {
  id: string;
  description: string;
  keys: string[];
}

interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    items: [
      { id: "nav.search", description: "Focus search", keys: ["/"] },
      { id: "nav.zen", description: "Zen mode (fullscreen detail)", keys: ["Z"] },
      { id: "nav.dismiss", description: "Dismiss / Cancel", keys: ["Esc"] },
    ],
  },
  {
    // Scoped honestly: web-next only wires arrow-key selection on the
    // History list today, not Inbox or Templates, so it gets its own group
    // rather than reading as an app-wide "Navigation" promise.
    title: "History list",
    items: [
      { id: "history.prev-item", description: "Move selection up", keys: ["↑"] },
      { id: "history.next-item", description: "Move selection down", keys: ["↓"] },
    ],
  },
];

/** Key chip (manifest S8.2): mono 11.5 t3, min-width 26 centered, bg/border line, radius 6. */
function Keycap({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex min-w-[26px] shrink-0 items-center justify-center rounded-[6px] px-2 py-[3px] font-mono text-[11.5px]"
      style={{
        color: "var(--gw-t3)",
        background: "rgba(var(--gw-line-rgb),.06)",
        border: "1px solid rgba(var(--gw-line-rgb),.1)",
      }}
    >
      {children}
    </span>
  );
}

/** Flat hairline row (manifest S8.2): description left, key chips right. */
function ShortcutRow({ item }: { item: ShortcutItem }) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-0.5 py-[9px]"
      style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.05)" }}
    >
      <span className="text-[13px]" style={{ color: "var(--gw-t3)" }}>
        {item.description}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {item.keys.map((key) => (
          <Keycap key={key}>{key}</Keycap>
        ))}
      </div>
    </div>
  );
}

/**
 * Group label (manifest S8.1): mono 600 letter-spacing .16em uppercase t8.
 * 10.5px, matching SectionRule's eyebrow — same role (all-caps mono label),
 * so the same size; it had drifted to 10px with no reason for the split.
 */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="mb-2 block font-mono text-[10.5px] font-semibold uppercase"
      style={{ letterSpacing: ".16em", color: "var(--gw-t8)" }}
    >
      {children}
    </span>
  );
}

export function ShortcutsPane() {
  return (
    <div className="flex w-full flex-col gap-[26px]">
      <SectionRule label="Shortcuts" />
      {GROUPS.map((group) => (
        <section key={group.title}>
          <GroupLabel>{group.title}</GroupLabel>
          <div className="flex flex-col">
            {group.items.map((item) => (
              <ShortcutRow key={item.id} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
