import { describe, it, expect, vi } from "vitest";
import { queryTools } from "../tools/queries.js";

function mockClient(overrides?: any) {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn() },
    feedback: {
      query: vi.fn().mockResolvedValue({ data: { object: "list", data: [] }, error: null }),
      ...overrides?.feedback,
    },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: {
      query: vi.fn().mockResolvedValue({ data: { object: "list", data: [] }, error: null }),
      ...overrides?.audit,
    },
    stats: { get: vi.fn() },
  } as any;
}

describe("queryTools", () => {
  it("creates 2 tools with correct scopes", () => {
    const tools = queryTools(mockClient());
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("gatewerk_query_feedback");
    expect(tools[0].scope).toBe("feedback:read");
    expect(tools[1].name).toBe("gatewerk_query_audit");
    expect(tools[1].scope).toBe("audit:read");
  });

  it("query_feedback passes filter params", async () => {
    const client = mockClient();
    const tools = queryTools(client);
    await tools[0].handler({ template: "deploy", outcome: "approved", limit: 5 });
    expect(client.feedback.query).toHaveBeenCalledWith({ template: "deploy", outcome: "approved", limit: 5 });
  });

  it("query_audit passes filter params", async () => {
    const client = mockClient();
    const tools = queryTools(client);
    await tools[1].handler({ action: "review.decided", limit: 10 });
    expect(client.audit.query).toHaveBeenCalledWith({ action: "review.decided", limit: 10 });
  });
});
