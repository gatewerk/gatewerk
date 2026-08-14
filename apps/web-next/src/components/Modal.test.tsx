import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal focus trap", () => {
  it("wraps Tab at the boundaries of the dialog", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Test dialog">
        <button type="button">inner one</button>
        <button type="button">inner two</button>
      </Modal>,
    );
    const closeBtn = screen.getByLabelText("Close");
    const two = screen.getByText("inner two");
    two.focus(); // last focusable in the card
    fireEvent.keyDown(two, { key: "Tab" });
    expect(document.activeElement).toBe(closeBtn); // wrapped to first
    fireEvent.keyDown(closeBtn, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(two); // wrapped back to last
  });

  it("restores focus to the previously focused element on unmount", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { unmount } = render(
      <Modal onClose={() => {}} ariaLabel="Test dialog">
        <button type="button">inner</button>
      </Modal>,
    );
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  // Proves the render-time opener capture (fix for Important 1). Before the
  // fix, `opener` was read inside a passive effect, which runs AFTER React
  // applies commit-time autoFocus — so this failed with activeElement
  // falling to <body> instead of `outside`, exactly the InviteForm case.
  it("restores focus to the opener even when the modal content autoFocuses", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const { unmount } = render(
      <Modal onClose={() => {}} ariaLabel="Test dialog">
        <input autoFocus />
      </Modal>,
    );
    // autoFocus wins over the trap's own card.focus() while open.
    expect(document.activeElement?.tagName).toBe("INPUT");
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  // Proves the Shift+Tab-from-card wrap (fix for Important 2). Before the
  // fix, the handler only intercepted at the first/last boundaries, so with
  // no autoFocus content (focus left on the card), Shift+Tab was never
  // prevented and the trap leaked for the rest of the modal's life.
  it("wraps Shift+Tab back to the last focusable when focus is still on the card", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Test dialog">
        <button type="button">inner one</button>
        <button type="button">inner two</button>
      </Modal>,
    );
    const two = screen.getByText("inner two");
    const card = screen.getByRole("dialog");
    // No autoFocus content: the trap effect left focus on the card itself.
    expect(document.activeElement).toBe(card);
    const event = fireEvent.keyDown(document.activeElement as Element, {
      key: "Tab",
      shiftKey: true,
    });
    expect(document.activeElement).toBe(two); // wrapped to last
    expect(event).toBe(false); // fireEvent returns false when preventDefault was called
  });
});

describe("Modal card outline", () => {
  it("suppresses the UA focus-visible outline on the card", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Test dialog">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect((dialog as HTMLElement).style.outline).toBe("none");
  });
});

describe("Modal title", () => {
  it("renders the title inside the reserved header zone", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Test dialog" title="Test dialog">
        <p>body</p>
      </Modal>,
    );
    const title = screen.getByText("Test dialog");
    expect(title.className).toContain("font-semibold");
    const wrapper = title.parentElement as HTMLElement;
    expect(wrapper.className).toContain("pr-8");
    expect(wrapper.style.marginTop).toBe("-30px");
  });
});

describe("Modal title semantics", () => {
  it("names the dialog via the visible h2 title when title is set", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Fallback name" title="Visible title">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Visible title" });
    expect(dialog.getAttribute("aria-label")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Visible title" })).toBeTruthy();
  });

  it("falls back to ariaLabel when there is no title", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="Fallback name">
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Fallback name" })).toBeTruthy();
  });

  it("renders the subtitle under the title with the shipped recipe", () => {
    render(
      <Modal onClose={() => {}} ariaLabel="T" title="T" subtitle="What this popup is for.">
        <p>body</p>
      </Modal>,
    );
    const sub = screen.getByText("What this popup is for.");
    expect(sub.className).toContain("text-[12px]");
    expect(sub.className).toContain("leading-relaxed");
  });
});
