import { describe, it, expect } from "vitest";
import { envelope, listEnvelope } from "@gatewerk/shared";

describe("Response Envelope", () => {
  it("envelope wraps a resource with object type", () => {
    const result = envelope("review", {
      id: "gw_rev_abc123",
      status: "pending",
      created_at: "2026-03-11T10:00:00Z",
    });
    expect(result).toEqual({
      id: "gw_rev_abc123",
      object: "review",
      status: "pending",
      created_at: "2026-03-11T10:00:00Z",
    });
  });

  it("envelope preserves all fields", () => {
    const result = envelope("template", {
      id: "gw_tpl_xyz",
      slug: "email-review",
      name: "Email Review",
      metadata: { foo: "bar" },
    });
    expect(result.object).toBe("template");
    expect(result.slug).toBe("email-review");
    expect(result.metadata).toEqual({ foo: "bar" });
  });

  it("listEnvelope wraps a list with pagination", () => {
    const items = [
      { id: "gw_rev_1", status: "pending" },
      { id: "gw_rev_2", status: "decided" },
    ];
    const result = listEnvelope("review", items, { has_more: false });
    expect(result).toEqual({
      object: "list",
      items: [
        { id: "gw_rev_1", object: "review", status: "pending" },
        { id: "gw_rev_2", object: "review", status: "decided" },
      ],
      has_more: false,
    });
  });

  it("listEnvelope includes total when provided", () => {
    const result = listEnvelope("review", [], { has_more: false, total: 0 });
    expect(result.total).toBe(0);
  });
});
