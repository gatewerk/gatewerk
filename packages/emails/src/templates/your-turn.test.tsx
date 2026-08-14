import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { YourTurnEmail } from "./your-turn";

describe("YourTurnEmail", () => {
  it("renders subject, html, text with the title and a per-review CTA link", async () => {
    const out = await renderEmail(YourTurnEmail, {
      title: "Your turn · invoice",
      reviewUrl: "https://app.gatewerk.com/reviews/rev_a1b2c3",
    });
    expect(out.subject).toContain("Your turn");
    expect(out.text.length).toBeGreaterThan(0);
    // The CTA must deep-link to the specific review, not the inbox root. The
    // reader arriving at a list and having to hunt for the item the email was
    // about is the defect this replaced.
    expect(out.html).toContain(
      'href="https://app.gatewerk.com/reviews/rev_a1b2c3"',
    );
  });
});
