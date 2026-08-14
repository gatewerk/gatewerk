import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("bordered green renders the ReviewRow chip recipe", () => {
    render(<StatusBadge tone="green">Approved</StatusBadge>);
    const el = screen.getByText("Approved");
    expect(el.className).toContain("text-[9.5px]");
    expect(el.className).toContain("tracking-[.12em]");
    // jsdom's CSS serializer structurally renormalizes a pure-numeric
    // rgba() shorthand (adds spacing, expands ".35" to "0.35") in both
    // style.border and the raw style attribute — there is no literal-string
    // escape hatch. The source recipe still carries the exact
    // "rgba(33,181,113,.35)" literal (see StatusBadge.tsx); this asserts
    // jsdom's semantically-equivalent normalized form.
    expect(el.style.border).toBe("1px solid rgba(33, 181, 113, 0.35)");
    expect(el.style.color).toBe("var(--gw-green-d)");
    expect(el.style.padding).toBe("2px 6px");
  });

  it("bordered red matches the rejected/not-delivered recipe", () => {
    render(<StatusBadge tone="red">Email not delivered</StatusBadge>);
    const el = screen.getByText("Email not delivered");
    expect(el.style.color).toBe("var(--gw-red-t)");
    expect(el.style.border).toBe("1px solid rgba(var(--gw-red-rgb),.35)");
  });

  it("filled amber renders the DeliveriesPane recipe", () => {
    render(
      <StatusBadge variant="filled" tone="amber">
        pending
      </StatusBadge>,
    );
    const el = screen.getByText("pending");
    expect(el.className).toContain("text-[9px]");
    expect(el.className).toContain("px-[5px]");
    expect(el.style.background).toBe("rgba(var(--gw-amber-rgb),.1)");
    expect(el.style.color).toBe("var(--gw-amber-t)");
  });
});
