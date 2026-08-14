import { describe, it, expect, vi } from "vitest";
import { reviewTools } from "../tools/reviews.js";

function mockClient(overrides?: any) {
  return {
    reviews: {
      create: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending" }, error: null }),
      list: vi.fn().mockResolvedValue({ data: { object: "list", data: [] }, error: null }),
      get: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending", template: { actions: [{ id: "approve" }, { id: "reject" }] } }, error: null }),
      decide: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", decision: "approved" }, error: null }),
      retry: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending" }, error: null }),
      action: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "decided" }, error: null }),
      ...overrides?.reviews,
    },
    feedback: { query: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: { get: vi.fn() },
  } as any;
}

describe("gatewerk_take_review_action", () => {
  // T1: calls client.reviews.action() with mapped params
  it("T1: calls client.reviews.action with correct params", async () => {
    const client = mockClient();
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_take_review_action")!;

    const result = await tool.handler({
      review_id: "gw_rev_001",
      action_id: "approve",
      feedback: "LGTM",
    });

    expect(client.reviews.action).toHaveBeenCalledWith("gw_rev_001", {
      action_id: "approve",
      feedback: "LGTM",
      edited_payload: undefined,
      version: undefined,
    });
    expect(result.isError).toBeUndefined();
  });

  // T2: returns toolError on client error
  it("T2: returns toolError on client.reviews.action error", async () => {
    const client = mockClient({
      reviews: {
        action: vi.fn().mockResolvedValue({ data: null, error: { message: "Action not allowed" } }),
      },
    });
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_take_review_action")!;

    const result = await tool.handler({ review_id: "gw_rev_001", action_id: "approve" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Action not allowed");
  });
});

describe("gatewerk_list_review_actions", () => {
  // T3: calls client.reviews.get() and extracts template.actions
  it("T3: extracts template.actions from review GET response", async () => {
    const client = mockClient();
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_list_review_actions")!;

    const result = await tool.handler({ review_id: "gw_rev_001" });

    expect(client.reviews.get).toHaveBeenCalledWith("gw_rev_001");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.review_id).toBe("gw_rev_001");
    expect(parsed.actions).toEqual([{ id: "approve" }, { id: "reject" }]);
  });

  // T4: returns empty array when template present but actions absent
  it("T4: returns empty actions array if template.actions absent", async () => {
    const client = mockClient({
      reviews: {
        get: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending", template: {} }, error: null }),
      },
    });
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_list_review_actions")!;

    const result = await tool.handler({ review_id: "gw_rev_001" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.actions).toEqual([]);
  });

  // T5: schema rejects empty-string action_id
  it("T5: gatewerk_take_review_action schema rejects empty-string action_id", () => {
    const tools = reviewTools(mockClient());
    const tool = tools.find((t) => t.name === "gatewerk_take_review_action")!;
    expect(() => tool.schema.action_id.parse("")).toThrow();
  });

  // T6: schema rejects invalid version values
  it("T6: gatewerk_take_review_action schema rejects version=0, version=-1, version=1.5", () => {
    const tools = reviewTools(mockClient());
    const tool = tools.find((t) => t.name === "gatewerk_take_review_action")!;
    expect(() => tool.schema.version.parse(0)).toThrow();
    expect(() => tool.schema.version.parse(-1)).toThrow();
    expect(() => tool.schema.version.parse(1.5)).toThrow();
  });

  // T7: returns toolError when template is null
  it("T7: gatewerk_list_review_actions returns toolError when template is null", async () => {
    const client = mockClient({
      reviews: {
        get: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending", template: null }, error: null }),
      },
    });
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_list_review_actions")!;

    const result = await tool.handler({ review_id: "gw_rev_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no template associated");
  });

  // T8: returns toolError when template property is absent
  it("T8: gatewerk_list_review_actions returns toolError when template property absent", async () => {
    const client = mockClient({
      reviews: {
        get: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending" }, error: null }),
      },
    });
    const tools = reviewTools(client);
    const tool = tools.find((t) => t.name === "gatewerk_list_review_actions")!;

    const result = await tool.handler({ review_id: "gw_rev_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no template associated");
  });
});
