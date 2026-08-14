export type ThemePref = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const KEY = "gw-theme";
const PREFS: ThemePref[] = ["system", "dark", "light"];

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (PREFS as string[]).includes(v)) return v as ThemePref;
  } catch {
    // storage may throw in private mode / sandboxed iframes
  }
  return "system";
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle("gw-light", theme === "light");
}

export function prefersDark(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function setPref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // non-fatal
  }
  applyTheme(resolveTheme(pref, prefersDark()));
}
