import { describe, it, expect, vi } from "vitest";
import { getAllTools, filterByScopes } from "../server.js";

function mockClient() {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn(), action: vi.fn() },
    feedback: { query: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: { get: vi.fn() },
    chains: { create: vi.fn(), get: vi.fn(), getForReview: vi.fn() },
    notes: {
      create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn(),
      pin: vi.fn(), unpin: vi.fn(), tags: vi.fn(),
    },
  } as any;
}

// Tool inventory after Phase 6 MCP coverage:
//   reviews: 6   (create, list, get, decide, take_action, list_actions)
//   templates: 4 (list, create, update, delete)
//   queries: 2   (feedback, audit)
//   stats: 1     (get)
//   chains: 3    (start, get, get_for_review)
//   notes: 2     (create, list)
// Total: 18
describe("getAllTools", () => {
  it("returns 18 tools total", () => {
    const tools = getAllTools(mockClient());
    expect(tools).toHaveLength(18);
  });

  it("includes chain + note tools", () => {
    const names = getAllTools(mockClient()).map((t) => t.name);
    expect(names).toContain("gatewerk_start_chain_run");
    expect(names).toContain("gatewerk_get_chain_run");
    expect(names).toContain("gatewerk_get_chain_for_review");
    expect(names).toContain("gatewerk_create_note");
    expect(names).toContain("gatewerk_list_notes");
  });
});

describe("filterByScopes", () => {
  const tools = getAllTools(mockClient());

  it("returns 2 tools for agent preset", () => {
    const filtered = filterByScopes(tools, ["reviews:create", "feedback:read"]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.name)).toEqual([
      "gatewerk_create_review",
      "gatewerk_query_feedback",
    ]);
  });

  it("reviewer preset gets 6 review/template/feedback tools + notes:read/write", () => {
    const filtered = filterByScopes(tools, [
      "reviews:create", "reviews:read", "reviews:decide",
      "templates:read", "feedback:read",
      "notes:read", "notes:write",
    ]);
    // 6 review tools (create + list + get + decide + take_action + list_actions)
    // +2 chain reads (reviews:read); +1 templates list; +1 feedback query; +2 notes = 12.
    expect(filtered).toHaveLength(12);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("gatewerk_get_chain_run");
    expect(names).toContain("gatewerk_get_chain_for_review");
    expect(names).toContain("gatewerk_create_note");
    expect(names).toContain("gatewerk_list_notes");
  });

  it("returns all 18 tools for admin preset", () => {
    const allScopes = [
      "reviews:create", "reviews:read", "reviews:decide",
      "templates:read", "templates:write",
      "feedback:read", "audit:read", "stats:read",
      "notes:read", "notes:write",
    ];
    const filtered = filterByScopes(tools, allScopes);
    expect(filtered).toHaveLength(18);
  });

  it("templates:write unlocks gatewerk_start_chain_run", () => {
    const filtered = filterByScopes(tools, ["templates:write"]);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("gatewerk_start_chain_run");
  });

  it("notes:read alone unlocks only gatewerk_list_notes", () => {
    const filtered = filterByScopes(tools, ["notes:read"]);
    expect(filtered.map((t) => t.name)).toEqual(["gatewerk_list_notes"]);
  });

  it("notes:write alone unlocks only gatewerk_create_note", () => {
    const filtered = filterByScopes(tools, ["notes:write"]);
    expect(filtered.map((t) => t.name)).toEqual(["gatewerk_create_note"]);
  });

  it("returns empty array for empty scopes", () => {
    const filtered = filterByScopes(tools, []);
    expect(filtered).toHaveLength(0);
  });
});

describe("createGatewerkMcpServer startup failures", () => {
  it("throws on 401 (invalid key)", async () => {
    const { createGatewerkMcpServer } = await import("../server.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" }));

    await expect(createGatewerkMcpServer({ apiKey: "ck_bad", url: "http://localhost:3100" }))
      .rejects.toThrow("Invalid API key");

    vi.unstubAllGlobals();
  });

  it("exposes all tools with a stderr warning when the instance is unreachable", async () => {
    const { createGatewerkMcpServer } = await import("../server.js");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createGatewerkMcpServer({ apiKey: "ck_test", url: "http://localhost:9999" }))
      .resolves.toBeDefined();
    const output = stderr.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Cannot connect to Gatewerk at http://localhost:9999");
    expect(output).toContain("registered 18/18");

    stderr.mockRestore();
    vi.unstubAllGlobals();
  });

  it("registers all tools when the key has null scopes (full access)", async () => {
    const { createGatewerkMcpServer } = await import("../server.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scopes: null }),
    }));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createGatewerkMcpServer({ apiKey: "ck_test", url: "http://localhost:3100" }))
      .resolves.toBeDefined();
    const output = stderr.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("registered 18/18");
    expect(output).toContain("full access");

    stderr.mockRestore();
    vi.unstubAllGlobals();
  });

  it("throws when zero tools after scope filtering", async () => {
    const { createGatewerkMcpServer } = await import("../server.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ scopes: ["nonexistent:scope"] }),
    }));

    await expect(createGatewerkMcpServer({ apiKey: "ck_test", url: "http://localhost:3100" }))
      .rejects.toThrow("API key has no scopes that map to MCP tools");

    vi.unstubAllGlobals();
  });
});
