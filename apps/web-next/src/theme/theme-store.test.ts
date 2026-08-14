import { describe, it, expect } from "vitest";
import { resolveTheme, readPref } from "./theme-store";

describe("resolveTheme", () => {
  it("system + prefers dark → dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });
  it("system + prefers light → light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("explicit pref wins over system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("readPref", () => {
  it("defaults to system when unset", () => {
    localStorage.removeItem("gw-theme");
    expect(readPref()).toBe("system");
  });
  it("reads a stored pref", () => {
    localStorage.setItem("gw-theme", "light");
    expect(readPref()).toBe("light");
  });
  it("ignores an invalid stored value", () => {
    localStorage.setItem("gw-theme", "bogus");
    expect(readPref()).toBe("system");
  });
});
