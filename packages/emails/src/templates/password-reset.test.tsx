import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { PasswordResetEmail } from "./password-reset";

describe("PasswordResetEmail", () => {
  it("renders reset link + subject + non-empty text, no <style>", async () => {
    const out = await renderEmail(PasswordResetEmail, {
      resetUrl: "https://app.gatewerk.com/reset-password?token=xyz",
    });
    expect(out.subject).toBe("Reset your Gatewerk password");
    expect(out.html).toContain(
      "https://app.gatewerk.com/reset-password?token=xyz",
    );
    expect(out.html).toContain("1 hour");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
});
