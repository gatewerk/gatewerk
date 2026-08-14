import { describe, it, expect, vi } from "vitest";
import { reviewTools } from "../tools/reviews.js";

function mockClient(overrides?: any) {
  return {
    reviews: {
      create: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending" }, error: null }),
      list: vi.fn().mockResolvedValue({ data: { object: "list", data: [] }, error: null }),
      get: vi.fn().mockResolvedValue({ data: { id: "gw_rev_001", status: "pending" }, error: null }),
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

describe("reviewTools", () => {
  it("creates 6 tools with correct scopes", () => {
    const tools = reviewTools(mockClient());
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name)).toEqual([
      "gatewerk_create_review",
      "gatewerk_list_reviews",
      "gatewerk_get_review",
      "gatewerk_decide_review",
      "gatewerk_take_review_action",
      "gatewerk_list_review_actions",
    ]);
    expect(tools[0].scope).toBe("reviews:create");
    expect(tools[1].scope).toBe("reviews:read");
    expect(tools[2].scope).toBe("reviews:read");
    expect(tools[3].scope).toBe("reviews:decide");
    expect(tools[4].scope).toBe("reviews:decide");
    expect(tools[5].scope).toBe("reviews:read");
  });

  it("create_review calls client.reviews.create", async () => {
    const client = mockClient();
    const tools = reviewTools(client);
    const result = await tools[0].handler({ template: "deploy", payload: {}, callback_url: "https://x.com/wh" });
    expect(client.reviews.create).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
  });

  it("decide_review routes 'retried' to client.reviews.retry", async () => {
    const client = mockClient();
    const tools = reviewTools(client);
    await tools[3].handler({ review_id: "gw_rev_001", decision: "retried", feedback: "fix typo" });
    expect(client.reviews.retry).toHaveBeenCalledWith("gw_rev_001", { feedback: "fix typo", prompt_edit: undefined });
    expect(client.reviews.decide).not.toHaveBeenCalled();
  });

  it("decide_review routes non-retry to client.reviews.decide", async () => {
    const client = mockClient();
    const tools = reviewTools(client);
    await tools[3].handler({ review_id: "gw_rev_001", decision: "approved", feedback: "LGTM" });
    expect(client.reviews.decide).toHaveBeenCalledOnce();
    expect(client.reviews.retry).not.toHaveBeenCalled();
  });

  it("decide_review uses GATEWERK_REVIEWER when no explicit reviewer", async () => {
    const client = mockClient();
    const tools = reviewTools(client, "alice@team.com");
    await tools[3].handler({ review_id: "gw_rev_001", decision: "approved" });
    expect(client.reviews.decide).toHaveBeenCalledWith("gw_rev_001", expect.objectContaining({ reviewer: "alice@team.com" }));
  });

  it("decide_review explicit reviewer overrides GATEWERK_REVIEWER", async () => {
    const client = mockClient();
    const tools = reviewTools(client, "alice@team.com");
    await tools[3].handler({ review_id: "gw_rev_001", decision: "approved", reviewer: "bob@team.com" });
    expect(client.reviews.decide).toHaveBeenCalledWith("gw_rev_001", expect.objectContaining({ reviewer: "bob@team.com" }));
  });

  it("returns error on SDK failure", async () => {
    const client = mockClient({ reviews: { create: vi.fn().mockResolvedValue({ data: null, error: { message: "Bad request" } }) } });
    const tools = reviewTools(client);
    const result = await tools[0].handler({ template: "x", payload: {}, callback_url: "https://x.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Bad request");
  });
});
