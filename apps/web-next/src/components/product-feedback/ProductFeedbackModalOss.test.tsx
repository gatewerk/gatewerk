import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProductFeedbackModalOss } from "./ProductFeedbackModalOss";

afterEach(cleanup);

describe("ProductFeedbackModalOss", () => {
  it("offers exactly the two link paths and no input", () => {
    render(<ProductFeedbackModalOss onClose={() => {}} />);
    const issue = screen.getByRole("link", { name: /open a github issue/i });
    // jest-dom matchers are not set up in vitest.config.ts, so assert via
    // the raw attribute rather than toHaveAttribute.
    expect(issue.getAttribute("href")).toBe("https://github.com/gatewerk/gatewerk/issues");
    const mail = screen.getByRole("link", { name: /hello@gatewerk\.com/i });
    expect(mail.getAttribute("href")).toBe("mailto:hello@gatewerk.com");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("invites all feedback kinds and promises a human reader", () => {
    render(<ProductFeedbackModalOss onClose={() => {}} />);
    expect(
      screen.getByText("Bug, idea, or anything else? A human reads every one:"),
    ).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ProductFeedbackModalOss onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
