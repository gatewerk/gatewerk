import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { NewIpLoginEmail } from "./new-ip-login";

describe("NewIpLoginEmail", () => {
  it("renders ip, browser, time + subject; no <style>", async () => {
    const out = await renderEmail(NewIpLoginEmail, {
      ip: "203.0.113.7", userAgent: "Chrome on macOS", detectedAt: "2026-06-04T20:00:00.000Z",
    });
    expect(out.subject).toBe("New sign-in to your Gatewerk account");
    expect(out.html).toContain("203.0.113.7");
    expect(out.html).toContain("Chrome on macOS");
    // The timestamp is formatted for a human, not echoed as ISO. This is the
    // one kind of email a reader scans for "was that me, at that time".
    expect(out.html).toContain("Jun 4, 2026, 8:00 PM UTC");
    expect(out.html).not.toContain("2026-06-04T20:00:00.000Z");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
  it("falls back to Unknown browser when userAgent absent", async () => {
    const out = await renderEmail(NewIpLoginEmail, { ip: "203.0.113.7", detectedAt: "2026-06-04T20:00:00.000Z" });
    expect(out.html).toContain("Unknown");
  });
  it("passes an unparseable timestamp through rather than hiding it", async () => {
    const out = await renderEmail(NewIpLoginEmail, { ip: "203.0.113.7", detectedAt: "not-a-date" });
    expect(out.html).toContain("not-a-date");
  });
});
