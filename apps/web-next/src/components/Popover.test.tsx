import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Popover } from "./Popover";

afterEach(cleanup);

describe("Popover", () => {
  it("renders nothing when closed and the panel when open", () => {
    const { rerender } = render(
      <Popover open={false} onClose={() => {}} width={216}>
        <button type="button">Item</button>
      </Popover>,
    );
    expect(screen.queryByText("Item")).toBeNull();
    rerender(
      <Popover open onClose={() => {}} width={216}>
        <button type="button">Item</button>
      </Popover>,
    );
    expect(screen.getByText("Item")).toBeTruthy();
  });

  it("closes on Escape via the escape-layer stack", () => {
    const onClose = vi.fn();
    render(
      <Popover open onClose={onClose} width={216}>
        <button type="button">Item</button>
      </Popover>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click outside (the catcher)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Popover open onClose={onClose} width={216}>
        <button type="button">Item</button>
      </Popover>,
    );
    const catcher = container.querySelector(".fixed.inset-0");
    fireEvent.click(catcher!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
