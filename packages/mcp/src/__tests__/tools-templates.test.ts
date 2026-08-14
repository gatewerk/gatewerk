import { describe, it, expect, vi } from "vitest";
import { templateTools } from "../tools/templates.js";

function mockClient(overrides?: any) {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn() },
    feedback: { query: vi.fn() },
    templates: {
      list: vi.fn().mockResolvedValue({ data: { object: "list", data: [] }, error: null }),
      get: vi.fn().mockResolvedValue({ data: { id: "gw_tpl_001" }, error: null }),
      create: vi.fn().mockResolvedValue({ data: { id: "gw_tpl_002", slug: "new" }, error: null }),
      update: vi.fn().mockResolvedValue({ data: { id: "gw_tpl_001", name: "Updated" }, error: null }),
      delete: vi.fn().mockResolvedValue({ data: { id: "gw_tpl_001", deleted: true }, error: null }),
      ...overrides?.templates,
    },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: { get: vi.fn() },
  } as any;
}

describe("templateTools", () => {
  it("creates 4 tools with correct scopes", () => {
    const tools = templateTools(mockClient());
    expect(tools).toHaveLength(4);
    expect(tools[0].scope).toBe("templates:read");
    expect(tools[1].scope).toBe("templates:write");
    expect(tools[2].scope).toBe("templates:write");
    expect(tools[3].scope).toBe("templates:write");
  });

  it("create_template calls client.templates.create", async () => {
    const client = mockClient();
    const tools = templateTools(client);
    await tools[1].handler({ slug: "test", name: "Test", fields: [], actions: ["approve"] });
    expect(client.templates.create).toHaveBeenCalledOnce();
  });

  it("update_template extracts template_id and passes rest", async () => {
    const client = mockClient();
    const tools = templateTools(client);
    await tools[2].handler({ template_id: "gw_tpl_001", name: "Updated" });
    expect(client.templates.update).toHaveBeenCalledWith("gw_tpl_001", { name: "Updated" });
  });

  it("delete_template calls client.templates.delete", async () => {
    const client = mockClient();
    const tools = templateTools(client);
    await tools[3].handler({ template_id: "gw_tpl_001" });
    expect(client.templates.delete).toHaveBeenCalledWith("gw_tpl_001");
  });
});
