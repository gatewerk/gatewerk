/**
 * Pure-logic tests for sectionFromPath.
 *
 * web-next has no React-render test harness (no @testing-library/react, no MSW).
 * All tests here are pure function unit tests — no DOM render.
 */
import { describe, it, expect } from "vitest";
import { sectionFromPath } from "./Settings";

describe("sectionFromPath", () => {
  it("returns default 'account' for bare /settings", () => {
    expect(sectionFromPath("/settings")).toBe("account");
  });

  it("returns default 'account' for /settings/ trailing slash", () => {
    expect(sectionFromPath("/settings/")).toBe("account");
  });

  it("returns default 'account' for unknown segment", () => {
    expect(sectionFromPath("/settings/unknown-tab")).toBe("account");
  });

  it("returns default 'account' for empty string", () => {
    expect(sectionFromPath("")).toBe("account");
  });

  it("resolves every registered section", () => {
    for (const s of ["account", "project", "activity", "security"]) {
      expect(sectionFromPath(`/settings/${s}`)).toBe(s);
    }
  });

  it("maps every legacy section to its new home", () => {
    expect(sectionFromPath("/settings/api-keys")).toBe("project");
    expect(sectionFromPath("/settings/webhooks")).toBe("project");
    expect(sectionFromPath("/settings/deliveries")).toBe("activity");
    expect(sectionFromPath("/settings/notifications")).toBe("account");
    expect(sectionFromPath("/settings/integrations")).toBe("account");
    expect(sectionFromPath("/settings/shortcuts")).toBe("account");
  });
});
