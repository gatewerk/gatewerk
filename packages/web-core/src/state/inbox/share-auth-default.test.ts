import { describe, it, expect } from "vitest";
import { seedShareAuthLevel, SHARE_AUTH_FALLBACK } from "./share-auth-default";

// The asymmetry IS the contract, so the weakening direction is tested harder
// than the strengthening one. A regression here does not throw or look wrong
// on screen — it just hands out public links, which is the failure nobody
// notices until a decision cannot name who made it.
describe("seedShareAuthLevel", () => {
  it("seeds a template that asked for email_otp", () => {
    expect(seedShareAuthLevel("email_otp")).toBe("email_otp");
  });

  it("seeds a template that asked for account", () => {
    expect(seedShareAuthLevel("account")).toBe("account");
  });

  it("refuses to weaken to public — the DB default is public, not an intent", () => {
    expect(seedShareAuthLevel("public")).toBe("email_otp");
  });

  it("falls back when the template says nothing", () => {
    expect(seedShareAuthLevel(undefined)).toBe("email_otp");
    expect(seedShareAuthLevel(null)).toBe("email_otp");
  });

  it("falls back on a value outside the enum rather than trusting it", () => {
    expect(seedShareAuthLevel("PUBLIC")).toBe("email_otp");
    expect(seedShareAuthLevel("none")).toBe("email_otp");
    expect(seedShareAuthLevel(0)).toBe("email_otp");
    expect(seedShareAuthLevel({})).toBe("email_otp");
  });

  it("never returns public for any input", () => {
    const inputs = ["public", "", undefined, null, 0, false, [], {}, "account", "email_otp"];
    for (const input of inputs) {
      expect(seedShareAuthLevel(input)).not.toBe("public");
    }
  });

  it("keeps the exported fallback and the function in agreement", () => {
    expect(seedShareAuthLevel(undefined)).toBe(SHARE_AUTH_FALLBACK);
  });
});
