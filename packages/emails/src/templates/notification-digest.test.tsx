import { describe, it, expect } from "vitest";
import { renderEmail } from "../index";
import { NotificationDigestEmail } from "./notification-digest";

const BASE_PROPS = {
  count: 4,
  sampleTitles: ["Approve invoice #1234", "Review agent output"],
  inboxUrl: "https://app.gatewerk.com",
  unsubscribeUrl: "https://app.gatewerk.com/unsubscribe?token=abc123",
};

describe("NotificationDigestEmail", () => {
  it("subject contains the count", async () => {
    const out = await renderEmail(NotificationDigestEmail, BASE_PROPS);
    expect(out.subject).toContain("4");
  });

  it("html contains inboxUrl", async () => {
    const out = await renderEmail(NotificationDigestEmail, BASE_PROPS);
    expect(out.html).toContain(BASE_PROPS.inboxUrl);
  });

  it("html contains unsubscribeUrl", async () => {
    const out = await renderEmail(NotificationDigestEmail, BASE_PROPS);
    expect(out.html).toContain(BASE_PROPS.unsubscribeUrl);
  });

  it("produces non-empty plain text", async () => {
    const out = await renderEmail(NotificationDigestEmail, BASE_PROPS);
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("renders sample titles in html", async () => {
    const out = await renderEmail(NotificationDigestEmail, BASE_PROPS);
    expect(out.html).toContain("Approve invoice #1234");
    expect(out.html).toContain("Review agent output");
  });

  it("uses singular noun for count of 1", async () => {
    const out = await renderEmail(NotificationDigestEmail, {
      ...BASE_PROPS,
      count: 1,
    });
    expect(out.subject).toContain("1");
  });
});
