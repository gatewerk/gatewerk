import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { TestEmail } from "./test-email";

describe("TestEmail", () => {
  it("renders fixed subject + body, no <style>", async () => {
    const out = await renderEmail(TestEmail, {});
    expect(out.subject).toBe("Gatewerk test email");
    expect(out.html).toContain("test message from Gatewerk");
    expect(out.html).toContain("outbound email is wired correctly");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
});
