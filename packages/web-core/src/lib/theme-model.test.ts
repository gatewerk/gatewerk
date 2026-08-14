import { describe, expect, it } from "vitest";
import { classesFor, migrateStoredTheme } from "./theme-model";

describe("migrateStoredTheme", () => {
  it("collapses legacy dark variants to dark", () => {
    for (const v of ["dark", "dark-plus", "cool-steel", "pure-oklch", "modern", "supabase", "claude-warm"]) {
      expect(migrateStoredTheme(v)).toBe("dark");
    }
  });
  it("collapses legacy light variants to light", () => {
    for (const v of ["light", "light-warm", "light-cool"]) {
      expect(migrateStoredTheme(v)).toBe("light");
    }
  });
  it("keeps system, and defaults missing or unknown values to system", () => {
    expect(migrateStoredTheme("system")).toBe("system");
    expect(migrateStoredTheme(null)).toBe("system");
    expect(migrateStoredTheme("garbage")).toBe("system");
  });
});

describe("classesFor", () => {
  it("dark pref applies dark + the warm legacy companion, never gw-light", () => {
    expect(classesFor("dark", false)).toEqual(["dark", "modern"]);
  });
  it("light pref applies gw-light + light-warm companion", () => {
    expect(classesFor("light", true)).toEqual(["gw-light", "light-warm"]);
  });
  it("system follows the media query", () => {
    expect(classesFor("system", true)).toEqual(["dark", "modern"]);
    expect(classesFor("system", false)).toEqual(["gw-light", "light-warm"]);
  });
});
