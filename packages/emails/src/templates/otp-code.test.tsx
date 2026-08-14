import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { OtpCodeEmail } from "./otp-code";

describe("OtpCodeEmail", () => {
  it("renders subject, html, text with the code", async () => {
    const out = await renderEmail(OtpCodeEmail, { code: "483920" });
    expect(out.subject).toBe("Your Gatewerk verification code: 483920");
    expect(out.html).toContain("483920");
    expect(out.text).toContain("483920");
    expect(out.text.toLowerCase()).toContain("expire");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
  it("uses the default 10 minute expiry", async () => {
    const out = await renderEmail(OtpCodeEmail, { code: "111111" });
    expect(out.html).toContain("10 minutes");
  });
});
