import { describe, expect, it } from "vitest";
import { safeUrl } from "./safe-url";

describe("safeUrl", () => {
  it("passes absolute http and https URLs through", () => {
    expect(safeUrl("https://example.com/a?b=1", "link")).toBe(
      "https://example.com/a?b=1",
    );
    expect(safeUrl("http://example.com/", "media")).toBe("http://example.com/");
  });

  it("allows mailto for links but not for media", () => {
    expect(safeUrl("mailto:ops@example.com", "link")).toBe(
      "mailto:ops@example.com",
    );
    expect(safeUrl("mailto:ops@example.com", "media")).toBeNull();
  });

  it("rejects javascript: however it is dressed up", () => {
    expect(safeUrl("javascript:alert(1)", "link")).toBeNull();
    expect(safeUrl("JaVaScRiPt:alert(1)", "link")).toBeNull();
    expect(safeUrl("  javascript:alert(1)", "link")).toBeNull();
    expect(safeUrl("\tjavascript:alert(1)", "link")).toBeNull();
  });

  it("rejects data: and other non-allowlisted schemes", () => {
    expect(
      safeUrl("data:text/html;base64,PHNjcmlwdD4x", "link"),
    ).toBeNull();
    expect(safeUrl("data:image/svg+xml,<svg onload=alert(1)>", "media")).toBeNull();
    expect(safeUrl("file:///etc/passwd", "link")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)", "link")).toBeNull();
  });

  it("rejects relative, empty and non-string values", () => {
    expect(safeUrl("/relative/path", "link")).toBeNull();
    expect(safeUrl("", "link")).toBeNull();
    expect(safeUrl("   ", "link")).toBeNull();
    expect(safeUrl(null, "link")).toBeNull();
    expect(safeUrl(42, "link")).toBeNull();
    expect(safeUrl({ href: "https://example.com" }, "link")).toBeNull();
  });
});
