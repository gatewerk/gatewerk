import { describe, it, expect } from "vitest";
import { generateId, parseId, isValidId, ID_PREFIXES } from "@gatewerk/shared";

describe("Prefixed IDs", () => {
  it("generateId creates ID with correct prefix", () => {
    const id = generateId("review");
    expect(id).toMatch(/^gw_rev_[a-zA-Z0-9_-]{24}$/);
  });

  it("generateId creates unique IDs", () => {
    const a = generateId("review");
    const b = generateId("review");
    expect(a).not.toBe(b);
  });

  it("generateId works for all resource types", () => {
    expect(generateId("review")).toMatch(/^gw_rev_/);
    expect(generateId("template")).toMatch(/^gw_tpl_/);
    expect(generateId("project")).toMatch(/^gw_prj_/);
    expect(generateId("api_key")).toMatch(/^gw_key_/);
    expect(generateId("webhook")).toMatch(/^gw_wh_/);
    expect(generateId("event")).toMatch(/^gw_evt_/);
    expect(generateId("user")).toMatch(/^gw_usr_/);
    expect(generateId("version")).toMatch(/^gw_ver_/);
  });

  it("parseId extracts type and random part", () => {
    const id = generateId("review");
    const parsed = parseId(id);
    expect(parsed).toEqual({
      type: "review",
      prefix: "gw_rev_",
      random: id.slice("gw_rev_".length),
    });
  });

  it("parseId returns null for invalid ID", () => {
    expect(parseId("invalid-id")).toBeNull();
    expect(parseId("gw_xxx_abc")).toBeNull();
    expect(parseId("")).toBeNull();
  });

  it("isValidId validates correctly", () => {
    const id = generateId("review");
    expect(isValidId(id, "review")).toBe(true);
    expect(isValidId(id, "template")).toBe(false);
    expect(isValidId("not-an-id", "review")).toBe(false);
  });

  it("ID_PREFIXES maps all resource types", () => {
    expect(ID_PREFIXES.review).toBe("gw_rev_");
    expect(ID_PREFIXES.template).toBe("gw_tpl_");
    expect(ID_PREFIXES.project).toBe("gw_prj_");
    expect(ID_PREFIXES.api_key).toBe("gw_key_");
    expect(ID_PREFIXES.webhook).toBe("gw_wh_");
    expect(ID_PREFIXES.event).toBe("gw_evt_");
    expect(ID_PREFIXES.user).toBe("gw_usr_");
    expect(ID_PREFIXES.version).toBe("gw_ver_");
  });
});
