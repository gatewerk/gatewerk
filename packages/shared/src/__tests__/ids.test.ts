import { describe, it, expect } from "vitest";
import { ID_PREFIXES, generateId, parseId } from "../ids";

describe("ID prefixes", () => {
  it("includes pin prefix gw_pin_", () => {
    expect(ID_PREFIXES.pin).toBe("gw_pin_");
  });

  it("generateId('pin') returns gw_pin_ prefixed id", () => {
    const id = generateId("pin");
    expect(id.startsWith("gw_pin_")).toBe(true);
  });

  it("parseId on gw_pin_ id returns type=pin", () => {
    const id = generateId("pin");
    const parsed = parseId(id);
    expect(parsed?.type).toBe("pin");
  });

  it("includes notification prefix gw_notif_", () => {
    expect(ID_PREFIXES.notification).toBe("gw_notif_");
  });

  it("generateId('notification') returns gw_notif_ prefixed id", () => {
    const id = generateId("notification");
    expect(id.startsWith("gw_notif_")).toBe(true);
  });

  it("parseId on gw_notif_ id returns type=notification", () => {
    const id = generateId("notification");
    const parsed = parseId(id);
    expect(parsed?.type).toBe("notification");
  });

  it("includes suppression prefix gw_supp_", () => {
    expect(ID_PREFIXES.suppression).toBe("gw_supp_");
  });

  it("generateId('suppression') returns gw_supp_ prefixed id", () => {
    const id = generateId("suppression");
    expect(id.startsWith("gw_supp_")).toBe(true);
  });

  it("parseId on gw_supp_ id returns type=suppression", () => {
    const id = generateId("suppression");
    const parsed = parseId(id);
    expect(parsed?.type).toBe("suppression");
  });
});
