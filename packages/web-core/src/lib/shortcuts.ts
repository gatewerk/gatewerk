// packages/web-core/src/lib/shortcuts.ts

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShortcutBinding {
  key: string;
  meta?: boolean;
}

export interface ShortcutDef {
  id: string;
  description: string;
  section: "Navigation" | "Actions";
  customizable: boolean;
  defaultBinding: ShortcutBinding;
}

// ── Default definitions ──────────────────────────────────────────────────────

export const SHORTCUT_DEFS: ShortcutDef[] = [
  // Navigation
  { id: "nav.inbox", description: "Go to Inbox", section: "Navigation", customizable: true, defaultBinding: { key: "1" } },
  { id: "nav.history", description: "Go to History", section: "Navigation", customizable: true, defaultBinding: { key: "2" } },
  { id: "nav.templates", description: "Go to Templates", section: "Navigation", customizable: true, defaultBinding: { key: "3" } },
  { id: "nav.notes", description: "Go to Notes", section: "Navigation", customizable: true, defaultBinding: { key: "4" } },
  { id: "nav.settings", description: "Go to Settings", section: "Navigation", customizable: true, defaultBinding: { key: "5" } },
  { id: "nav.prev-filter", description: "Previous filter", section: "Navigation", customizable: false, defaultBinding: { key: "ArrowLeft" } },
  { id: "nav.next-filter", description: "Next filter", section: "Navigation", customizable: false, defaultBinding: { key: "ArrowRight" } },
  { id: "nav.prev-item", description: "Move selection up (or k)", section: "Navigation", customizable: false, defaultBinding: { key: "ArrowUp" } },
  { id: "nav.next-item", description: "Move selection down (or j)", section: "Navigation", customizable: false, defaultBinding: { key: "ArrowDown" } },
  { id: "nav.search", description: "Focus search", section: "Navigation", customizable: true, defaultBinding: { key: "/" } },
  { id: "nav.feedback", description: "Focus feedback", section: "Navigation", customizable: true, defaultBinding: { key: "f" } },
  { id: "nav.dismiss", description: "Dismiss / Cancel", section: "Navigation", customizable: false, defaultBinding: { key: "Escape" } },
  { id: "nav.sidebar", description: "Toggle menu", section: "Navigation", customizable: true, defaultBinding: { key: "[" } },
  { id: "nav.zen", description: "Zen mode (fullscreen detail)", section: "Navigation", customizable: true, defaultBinding: { key: "z" } },
  { id: "nav.shortcuts", description: "Keyboard shortcuts", section: "Navigation", customizable: true, defaultBinding: { key: "?" } },
  // Actions
  { id: "action.approve", description: "Approve", section: "Actions", customizable: true, defaultBinding: { key: "a" } },
  { id: "action.reject", description: "Reject", section: "Actions", customizable: true, defaultBinding: { key: "r" } },
  { id: "action.toggle-select", description: "Toggle select on row", section: "Actions", customizable: true, defaultBinding: { key: "x" } },
  { id: "action.edit", description: "Edit selected", section: "Actions", customizable: true, defaultBinding: { key: "e" } }, // display-only for now, no handler wired yet
  { id: "action.archive", description: "Archive selected", section: "Actions", customizable: true, defaultBinding: { key: "s" } },
  { id: "action.export", description: "Export / Download", section: "Actions", customizable: true, defaultBinding: { key: "d" } },
  { id: "action.new", description: "New template", section: "Actions", customizable: true, defaultBinding: { key: "n" } },
  { id: "action.delete", description: "Delete selected", section: "Actions", customizable: false, defaultBinding: { key: "Backspace" } },
  { id: "action.select-all", description: "Select all", section: "Actions", customizable: false, defaultBinding: { key: "a", meta: true } },
];

// ── localStorage ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "gatewerk_shortcut_overrides";

export function loadOverrides(): Record<string, ShortcutBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: Record<string, ShortcutBinding>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

export function clearAllOverrides(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ── Merge & lookup ───────────────────────────────────────────────────────────

export function getMergedBinding(actionId: string): ShortcutBinding {
  const overrides = loadOverrides();
  if (overrides[actionId]) return overrides[actionId];
  const def = SHORTCUT_DEFS.find((d) => d.id === actionId);
  return def?.defaultBinding ?? { key: "" };
}

// ── Matching ─────────────────────────────────────────────────────────────────

const ALPHA_RE = /^[a-zA-Z]$/;

export function matchesBinding(e: KeyboardEvent, binding: ShortcutBinding): boolean {
  // Meta/Ctrl check
  const hasMeta = e.metaKey || e.ctrlKey;
  if (binding.meta) {
    if (!hasMeta) return false;
  } else {
    if (hasMeta) return false;
  }

  // Key check
  if (ALPHA_RE.test(binding.key)) {
    // Alpha: case-insensitive but reject shift for non-meta (so Shift+A doesn't trigger "a")
    if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
    if (!binding.meta && e.shiftKey) return false;
    return true;
  }

  // Non-alpha: exact match (shift implicit in key value, e.g. "?" = Shift+/)
  return e.key === binding.key;
}

// ── Conflict detection ───────────────────────────────────────────────────────

export function bindingsMatch(a: ShortcutBinding, b: ShortcutBinding): boolean {
  const aKey = ALPHA_RE.test(a.key) ? a.key.toLowerCase() : a.key;
  const bKey = ALPHA_RE.test(b.key) ? b.key.toLowerCase() : b.key;
  return aKey === bKey && !!a.meta === !!b.meta;
}

// ── Display ──────────────────────────────────────────────────────────────────

const DISPLAY_MAP: Record<string, string> = {
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  Escape: "Esc",
  Backspace: "\u232B",
  Delete: "Del",
  " ": "Space",
  Enter: "\u21B5",
};

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.meta) parts.push(isMac ? "\u2318" : "Ctrl+");
  const display = DISPLAY_MAP[binding.key]
    ?? (ALPHA_RE.test(binding.key) ? binding.key.toUpperCase() : binding.key);
  parts.push(display);
  return parts.join("");
}

// ── Display sections (for overlay and settings) ──────────────────────────────

export interface ShortcutDisplayItem {
  id: string;
  description: string;
  label: string;
  customizable: boolean;
  meta?: boolean;
}

export interface ShortcutDisplaySection {
  title: string;
  shortcuts: ShortcutDisplayItem[];
}

export function getDisplaySections(): ShortcutDisplaySection[] {
  const overrides = loadOverrides();
  const sections = new Map<string, ShortcutDisplaySection>();

  for (const def of SHORTCUT_DEFS) {
    const binding = overrides[def.id] ?? def.defaultBinding;
    const section = sections.get(def.section) ?? { title: def.section, shortcuts: [] };
    section.shortcuts.push({
      id: def.id,
      description: def.description,
      label: formatBinding(binding),
      customizable: def.customizable,
      meta: binding.meta,
    });
    sections.set(def.section, section);
  }

  return Array.from(sections.values());
}
