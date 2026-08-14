import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { IconButton } from "./buttons";

afterEach(cleanup);

describe("IconButton", () => {
  it("defaults to 30x30 with 8px radius and no popover aria", () => {
    render(
      <IconButton title="Filter" onClick={() => {}}>
        <span />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Filter" });
    expect(btn.style.width).toBe("30px");
    expect(btn.style.height).toBe("30px");
    expect(btn.style.borderRadius).toBe("8px");
    expect(btn.getAttribute("aria-haspopup")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBeNull();
    expect(btn.className).toContain("relative");
  });

  it("keeps relative on the active recipe too, so absolutely positioned children anchor to the button", () => {
    render(
      <IconButton title="Filter" onClick={() => {}} active>
        <span />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Filter" });
    expect(btn.className).toContain("relative");
  });

  it("radius and size props override the defaults", () => {
    render(
      <IconButton title="Toggle" onClick={() => {}} size={34} radius={9}>
        <span />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Toggle" });
    expect(btn.style.width).toBe("34px");
    expect(btn.style.borderRadius).toBe("9px");
  });

  it("passes popover aria through when given", () => {
    render(
      <IconButton title="Filter" onClick={() => {}} aria-haspopup="dialog" aria-expanded>
        <span />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Filter" });
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});
