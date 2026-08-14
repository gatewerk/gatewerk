import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { EmailVerifyEmail } from "./email-verify";

describe("EmailVerifyEmail", () => {
  it("renders verify link + subject + non-empty text, no <style>", async () => {
    const out = await renderEmail(EmailVerifyEmail, {
      verifyUrl: "https://app.gatewerk.com/verify-email?token=abc",
    });
    expect(out.subject).toBe("Verify your Gatewerk email address");
    expect(out.html).toContain(
      "https://app.gatewerk.com/verify-email?token=abc",
    );
    expect(out.html).toContain("24 hours");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
});
