import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  ALL_THEME_CLASSES,
  classesFor,
  migrateStoredTheme,
  THEME_STORAGE_KEY,
  type ThemePref,
} from "@gatewerk/web-core/lib/theme-model";

type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: ThemePref;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePref) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
});

function getSystemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return getSystemPrefersDark() ? "dark" : "light";
  return pref;
}

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  root.classList.remove(...ALL_THEME_CLASSES);
  root.classList.add(...classesFor(pref, getSystemPrefersDark()));
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolve(pref) === "dark" ? "#1a1a18" : "#efece3");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(() => {
    try {
      return migrateStoredTheme(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return "system";
    }
  });

  const [resolvedTheme, setResolved] = useState<ResolvedTheme>(() => resolve(theme));

  function setTheme(next: ThemePref) {
    setThemeState(next);
    setResolved(resolve(next));
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {}
  }

  // Follow OS changes while in "system" mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      setResolved(resolve("system"));
      applyTheme("system");
    }
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Apply on mount
  useEffect(() => {
    applyTheme(theme);
    // react-hooks/exhaustive-deps: intentional mount-only. Subsequent theme
    // changes are applied synchronously inside `setTheme` — this effect only
    // covers the initial render where state was seeded from localStorage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
