import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Modal } from "./Modal";
import { SelectMenu } from "../screens/templates/_ui";

afterEach(cleanup);

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

describe("Escape layering", () => {
  it("closes only the open SelectMenu, not the Modal around it", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} ariaLabel="Test dialog">
        <SelectMenu value="a" options={OPTIONS} onChange={() => {}} ariaLabel="Pick one" />
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText("Pick one")); // open the menu
    expect(screen.getByText("Beta")).toBeTruthy(); // menu is open (portaled)

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("Beta")).toBeNull(); // menu closed
    expect(onClose).not.toHaveBeenCalled(); // modal survived  <-- FAILS at HEAD

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1); // second Escape closes the modal
  });

  it("still lets a lone Modal close on Escape and claims the event", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} ariaLabel="Test dialog">
        <p>body</p>
      </Modal>,
    );
    const claimed = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(claimed).toBe(false); // preventDefault was called — outer cascade bails
  });

  it("respects closeOnEscape=false (no layer registered, Escape falls through)", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} ariaLabel="Test dialog" closeOnEscape={false}>
        <p>body</p>
      </Modal>,
    );
    const claimed = fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(claimed).toBe(true); // event NOT claimed — matches current behavior
  });
});
