import { describe, it, expect } from "vitest";
import { isMobileSettingsSection, MOBILE_SETTINGS_SECTIONS } from "./Settings";

describe("isMobileSettingsSection", () => {
  it("allows account, the one everybody needs away from a desk", () => {
    expect(isMobileSettingsSection("account")).toBe(true);
  });

  it("allows security, so a locked out user can fix their own password", () => {
    expect(isMobileSettingsSection("security")).toBe(true);
  });

  it("refuses project, which is desk work", () => {
    expect(isMobileSettingsSection("project")).toBe(false);
  });

  it("refuses billing", () => {
    expect(isMobileSettingsSection("billing")).toBe(false);
  });

  it("refuses activity", () => {
    expect(isMobileSettingsSection("activity")).toBe(false);
  });

  it("lists exactly the two allowed sections, so the menu cannot drift", () => {
    expect([...MOBILE_SETTINGS_SECTIONS]).toEqual(["account", "security"]);
  });
});
