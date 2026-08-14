import { describe, it, expect } from "vitest";
import { renderDailyDigestEmail } from "../daily-digest-email";

describe("renderDailyDigestEmail", () => {
  it("renders singular subject when count is 1", async () => {
    const { subject, text, html } = await renderDailyDigestEmail({
      reviewer_id: "u1",
      email: "alice@example.com",
      count: 1,
      sample_review_ids: ["rev_1"],
    });
    expect(subject).toBe("Gatewerk: 1 review token expired without a response");
    expect(text).toContain("1");
    expect(text).toContain("review token");
    expect(html).toContain("1");
    expect(html).toContain("review token");
    expect(text).toContain("rev_1");
    // Defensive: a blank-render regression must fail loud, not pass vacuously.
    expect(text).toBeTruthy();
    expect(html).toBeTruthy();
  });

  it("renders plural subject when count > 1", async () => {
    const { subject, text, html } = await renderDailyDigestEmail({
      reviewer_id: "u1",
      email: "alice@example.com",
      count: 3,
      sample_review_ids: ["rev_1", "rev_2", "rev_3"],
    });
    expect(subject).toBe("Gatewerk: 3 review tokens expired without a response");
    // Defensive: a blank-render regression must fail loud, not pass vacuously.
    expect(text).toBeTruthy();
    expect(html).toBeTruthy();
  });

  it("never includes em dashes or en dashes", async () => {
    const { subject, text, html } = await renderDailyDigestEmail({
      reviewer_id: "u1",
      email: "alice@example.com",
      count: 1,
      sample_review_ids: ["rev_1"],
    });
    // Defensive: a blank-render regression must fail loud, not pass vacuously
    // (not.toMatch passes on an empty string, so assert non-empty first).
    expect(text).toBeTruthy();
    expect(html).toBeTruthy();
    expect(subject).not.toMatch(/—|–/);
    expect(text).not.toMatch(/—|–/);
    expect(html).not.toMatch(/—|–/);
  });
});
