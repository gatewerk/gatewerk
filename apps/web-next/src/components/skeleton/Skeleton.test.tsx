import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton, SkeletonRows } from "./Skeleton";

describe("Skeleton", () => {
  it("is hidden from AT and reserves its dimensions", () => {
    const { container } = render(<Skeleton width={200} height={16} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.style.width).toBe("200px");
    expect(el.style.height).toBe("16px");
    expect(el.style.background).toContain("--gw-line-rgb");
  });

  it("pulses only when motion is allowed", () => {
    const { container } = render(<Skeleton />);
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "motion-safe:animate-pulse",
    );
  });
});

describe("SkeletonRows", () => {
  it("renders the requested number of row blocks", () => {
    const { container } = render(<SkeletonRows count={5} rowHeight={64} />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.getAttribute("aria-hidden")).toBe("true");
    expect(wrap.children).toHaveLength(5);
  });
});
