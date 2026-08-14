import { createContext, useContext, useEffect, useState } from "react";
import {
  type ThemePref, type ResolvedTheme,
  readPref, resolveTheme, applyTheme, prefersDark, setPref as persistPref,
} from "./theme-store";

interface ThemeCtx {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (p: ThemePref) => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => readPref());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readPref(), prefersDark()),
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (pref === "system") {
        const next = resolveTheme("system", mq.matches);
        setResolved(next);
        applyTheme(next);
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    persistPref(p);
    setResolved(resolveTheme(p, prefersDark()));
  };

  return <Ctx.Provider value={{ pref, resolved, setPref }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used within ThemeProvider");
  return v;
}
