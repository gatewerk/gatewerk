/**
 * MarkdownField inline-edit commit-on-blur wiring — the class fix lives in
 * the shared hook (use-inline-edit.ts); this pins that MarkdownField actually
 * passes the hook's handleBlur through to its textarea, same as TextField.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MarkdownField } from "./MarkdownField";

afterEach(cleanup);

describe("MarkdownField inline edit — commit on blur", () => {
  it("blur with a changed draft commits the typed value", () => {
    const onCommit = vi.fn();
    render(<MarkdownField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "hello world" } });
    fireEvent.blur(textbox);

    expect(onCommit).toHaveBeenCalledWith("hello world");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("unchanged draft on blur — no commit, editor closes", () => {
    const onCommit = vi.fn();
    render(<MarkdownField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.blur(textbox);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
