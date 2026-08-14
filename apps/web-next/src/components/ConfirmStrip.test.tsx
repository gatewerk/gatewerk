import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmStrip } from "./ConfirmStrip";

afterEach(cleanup);

describe("ConfirmStrip", () => {
  it("fires onConfirm from the destructive button and onCancel from cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmStrip
        message={'Delete "prod hook"? This cannot be undone.'}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('Delete "prod hook"? This cannot be undone.')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
