/**
 * TextField inline-edit commit tests — the defect these pin against: clicking
 * away (blur) left `editing` true and the draft uncommitted, discarding it
 * silently. Pinned at the component level (hook wiring included): blur
 * commits a changed draft, Escape still wins over a same-tick blur, an
 * unchanged draft just closes, and Cmd/Ctrl+Enter keeps working.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { TextField } from "./TextField";

afterEach(cleanup);

describe("TextField inline edit — commit on blur", () => {
  it("T1: blur with a changed draft commits the typed value", () => {
    const onCommit = vi.fn();
    render(<TextField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "hello world" } });
    fireEvent.blur(textbox);

    expect(onCommit).toHaveBeenCalledWith("hello world");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("T2: Escape then a same-tick blur does not commit the abandoned draft", () => {
    const onCommit = vi.fn();
    render(<TextField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "changed" } });

    // Batch Escape + blur inside one act() so both dispatch before React
    // commits the cancel — this is the actual race (event order, not
    // "the field already unmounted so blur never arrives") the guard has
    // to survive; two separate fireEvent calls would flush in between and
    // hide a guard that only worked by unmount timing.
    act(() => {
      fireEvent.keyDown(textbox, { key: "Escape" });
      fireEvent.blur(textbox);
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("T3: unchanged draft on blur — no commit, editor closes", () => {
    const onCommit = vi.fn();
    render(<TextField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.blur(textbox);

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("T4: Cmd/Ctrl+Enter still commits (regression pin)", () => {
    const onCommit = vi.fn();
    render(<TextField value="hello" editable onCommit={onCommit} />);

    fireEvent.click(screen.getByText("hello"));
    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "typed" } });
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

    expect(onCommit).toHaveBeenCalledWith("typed");
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
