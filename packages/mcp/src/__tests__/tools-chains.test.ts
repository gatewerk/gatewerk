import { describe, it, expect, vi } from "vitest";
import { chainTools } from "../tools/chains.js";

function mockClient(overrides?: any) {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn() },
    feedback: { query: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: { get: vi.fn() },
    chains: {
      create: vi.fn().mockResolvedValue({
        data: { id: "gw_chain_001", status: "active", step_1_review_id: "gw_rev_001" },
        error: null,
      }),
      get: vi.fn().mockResolvedValue({
        data: { id: "gw_chain_001", status: "active", steps: [] },
        error: null,
      }),
      getForReview: vi.fn().mockResolvedValue({
        data: { id: "gw_chain_001", current_step_number: 1 },
        error: null,
      }),
      ...overrides?.chains,
    },
    notes: {
      create: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      pin: vi.fn(),
      unpin: vi.fn(),
      tags: vi.fn(),
    },
  } as any;
}

const minDefinition = {
  version: "1.0" as const,
  mode: "sequential" as const,
  steps: [
    {
      id: "step1",
      template: "deploy-review",
      assignee: { kind: "role" as const, role: "admin" as const },
    },
  ],
};

describe("chainTools", () => {
  it("creates 3 tools with correct names + scopes", () => {
    const tools = chainTools(mockClient());
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "gatewerk_start_chain_run",
      "gatewerk_get_chain_run",
      "gatewerk_get_chain_for_review",
    ]);
    expect(tools[0].scope).toBe("templates:write");
    expect(tools[1].scope).toBe("reviews:read");
    expect(tools[2].scope).toBe("reviews:read");
  });

  it("start_chain_run calls client.chains.create with mapped fields", async () => {
    const client = mockClient();
    const tools = chainTools(client);
    await tools[0].handler({
      definition: minDefinition,
      initial_payload: { foo: "bar" },
      callback_url: "https://example.com/webhook",
      metadata: { source: "agent" },
    });
    expect(client.chains.create).toHaveBeenCalledWith({
      definition: minDefinition,
      initial_payload: { foo: "bar" },
      callback_url: "https://example.com/webhook",
      metadata: { source: "agent" },
    });
  });

  it("start_chain_run omits callback_url when not provided", async () => {
    const client = mockClient();
    const tools = chainTools(client);
    await tools[0].handler({ definition: minDefinition, initial_payload: {} });
    expect(client.chains.create).toHaveBeenCalledWith({
      definition: minDefinition,
      initial_payload: {},
      callback_url: undefined,
      metadata: undefined,
    });
  });

  it("get_chain_run calls client.chains.get", async () => {
    const client = mockClient();
    const tools = chainTools(client);
    const result = await tools[1].handler({ chain_run_id: "gw_chain_001" });
    expect(client.chains.get).toHaveBeenCalledWith("gw_chain_001");
    expect(result.isError).toBeUndefined();
  });

  it("get_chain_for_review calls client.chains.getForReview", async () => {
    const client = mockClient();
    const tools = chainTools(client);
    await tools[2].handler({ review_id: "gw_rev_001" });
    expect(client.chains.getForReview).toHaveBeenCalledWith("gw_rev_001");
  });

  it("returns error result on SDK failure", async () => {
    const client = mockClient({
      chains: {
        create: vi.fn().mockResolvedValue({ data: null, error: { message: "Invalid definition" } }),
        get: vi.fn(),
        getForReview: vi.fn(),
      },
    });
    const tools = chainTools(client);
    const result = await tools[0].handler({ definition: minDefinition, initial_payload: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid definition");
  });

  it("error message does not echo api key from config", async () => {
    // Sanity: the tools never receive the apiKey directly — they use the
    // client closure. Confirm error path text is the SDK message only.
    const client = mockClient({
      chains: {
        create: vi.fn().mockResolvedValue({ data: null, error: { message: "Forbidden" } }),
        get: vi.fn(),
        getForReview: vi.fn(),
      },
    });
    const tools = chainTools(client);
    const result = await tools[0].handler({ definition: minDefinition, initial_payload: {} });
    expect(result.content[0].text).not.toMatch(/ck_[A-Za-z0-9]/);
  });
});
