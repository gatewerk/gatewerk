/**
 * NumberField inline-edit commit-on-blur wiring — the class fix lives in
 * the shared hook (use-inline-edit.ts); this pins that NumberField actually
 * passes the hook's handleBlur through to its input, same as TextField.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NumberField } from "./NumberField";

afterEach(cleanup);

describe("NumberField inline edit — commit on blur", () => {
  it("blur with a changed draft commits the typed value as a number", () => {
    const onCommit = vi.fn();
    render(<NumberField value={5} editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("5"));
    const input = screen.getByDisplayValue("5");
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith(42);
  });

  it("unchanged draft on blur — no commit", () => {
    const onCommit = vi.fn();
    render(<NumberField value={5} editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("5"));
    const input = screen.getByDisplayValue("5");
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
  });
});
