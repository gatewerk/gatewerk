/**
 * Warm-precision theme model (Phase 1 redesign). Both resolved themes pair a
 * warm-precision token set with a legacy companion class until the legacy
 * vocabulary is deleted at surface freeze:
 *   dark  → ["dark", "modern"]    (warm-precision dark + legacy warm variant)
 *   light → ["gw-light", "light-warm"] (warm-precision light + legacy cream variant)
 *
 * KEEP IN SYNC with public/theme-init.js, which replicates this logic because
 * it must run as a plain pre-hydration script.
 */
export type ThemePref = "system" | "dark" | "light";

export const THEME_STORAGE_KEY = "gatewerk_theme";

/** Every class any historical pref may have left on <html>. */
export const ALL_THEME_CLASSES = [
  "dark",
  "gw-light",
  "dark-plus",
  "cool-steel",
  "pure-oklch",
  "modern",
  "supabase",
  "claude-warm",
  "light-warm",
  "light-cool",
] as const;

export function classesFor(pref: ThemePref, systemPrefersDark: boolean): string[] {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark);
  return dark ? ["dark", "modern"] : ["gw-light", "light-warm"];
}

/** Map any historical stored value onto the collapsed pref set. */
export function migrateStoredTheme(raw: string | null): ThemePref {
  if (raw === "light" || raw === "light-warm" || raw === "light-cool") return "light";
  if (
    raw === "dark" || raw === "dark-plus" || raw === "cool-steel" || raw === "pure-oklch" ||
    raw === "modern" || raw === "supabase" || raw === "claude-warm"
  ) {
    return "dark";
  }
  return "system";
}
