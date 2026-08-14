import { describe, it, expect, vi } from "vitest";
import { statsTools } from "../tools/stats.js";

function mockClient(overrides?: any) {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn() },
    feedback: { query: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: {
      get: vi.fn().mockResolvedValue({ data: { total: 42, pending: 5 }, error: null }),
      ...overrides?.stats,
    },
  } as any;
}

describe("statsTools", () => {
  it("creates 1 tool with stats:read scope", () => {
    const tools = statsTools(mockClient());
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("gatewerk_get_stats");
    expect(tools[0].scope).toBe("stats:read");
  });

  it("get_stats calls client.stats.get", async () => {
    const client = mockClient();
    const tools = statsTools(client);
    const result = await tools[0].handler({});
    expect(client.stats.get).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("42");
  });

  it("returns error on SDK failure", async () => {
    const client = mockClient({ stats: { get: vi.fn().mockResolvedValue({ data: null, error: { message: "Forbidden" } }) } });
    const tools = statsTools(client);
    const result = await tools[0].handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Forbidden");
  });
});
