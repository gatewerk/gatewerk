import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { DailyDigestEmail } from "./daily-digest";

describe("DailyDigestEmail", () => {
  it("pluralizes for many and renders sample review links", async () => {
    const out = await renderEmail(DailyDigestEmail, {
      count: 3, sampleReviewIds: ["rev_a", "rev_b"], inboxUrl: "https://app.gatewerk.com",
    });
    expect(out.subject).toBe("Gatewerk: 3 review tokens expired without a response");
    expect(out.html).toContain("https://app.gatewerk.com/reviews/rev_a");
    expect(out.html).toContain("https://app.gatewerk.com/reviews/rev_b");
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
  it("uses singular noun for count of 1", async () => {
    const out = await renderEmail(DailyDigestEmail, { count: 1, sampleReviewIds: ["rev_x"], inboxUrl: "https://app.gatewerk.com" });
    expect(out.subject).toBe("Gatewerk: 1 review token expired without a response");
  });
});
