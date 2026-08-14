import { describe, it, expect, vi } from "vitest";
import { noteTools } from "../tools/notes.js";

function mockClient(overrides?: any) {
  return {
    reviews: { create: vi.fn(), list: vi.fn(), get: vi.fn(), decide: vi.fn(), retry: vi.fn() },
    feedback: { query: vi.fn() },
    templates: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    webhooks: { verify: vi.fn() },
    audit: { query: vi.fn() },
    stats: { get: vi.fn() },
    chains: { create: vi.fn(), get: vi.fn(), getForReview: vi.fn() },
    notes: {
      create: vi.fn().mockResolvedValue({
        data: {
          id: "gw_note_001",
          project_id: "gw_proj_001",
          body: "hello",
          tags: [],
          is_shared: true,
          attachments: [],
        },
        error: null,
      }),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue({
        data: { items: [], total: 0, has_more: false },
        error: null,
      }),
      update: vi.fn(),
      delete: vi.fn(),
      pin: vi.fn(),
      unpin: vi.fn(),
      tags: vi.fn(),
      ...overrides?.notes,
    },
  } as any;
}

describe("noteTools", () => {
  it("creates 2 tools with correct names + scopes", () => {
    const tools = noteTools(mockClient());
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual([
      "gatewerk_create_note",
      "gatewerk_list_notes",
    ]);
    expect(tools[0].scope).toBe("notes:write");
    expect(tools[1].scope).toBe("notes:read");
  });

  it("create_note passes through all body fields", async () => {
    const client = mockClient();
    const tools = noteTools(client);
    await tools[0].handler({
      body: "Looks good",
      tags: ["follow-up"],
      is_shared: true,
      attachments: [{ target_kind: "review", target_id: "gw_rev_001" }],
      project_id: "gw_proj_001",
    });
    expect(client.notes.create).toHaveBeenCalledWith({
      body: "Looks good",
      tags: ["follow-up"],
      is_shared: true,
      attachments: [{ target_kind: "review", target_id: "gw_rev_001" }],
      project_id: "gw_proj_001",
    });
  });

  it("create_note allows minimal body (api_key callers omit project_id)", async () => {
    const client = mockClient();
    const tools = noteTools(client);
    await tools[0].handler({ body: "ack" });
    expect(client.notes.create).toHaveBeenCalledWith({
      body: "ack",
      tags: undefined,
      is_shared: undefined,
      attachments: undefined,
      project_id: undefined,
    });
  });

  it("list_notes passes filters through to client.notes.list", async () => {
    const client = mockClient();
    const tools = noteTools(client);
    await tools[1].handler({
      project_id: "gw_proj_001",
      author_id: "user_alice",
      is_shared: true,
      tags: ["risk"],
      attached_to_kind: "review",
      attached_to_id: "gw_rev_001",
      has_attachments: true,
      limit: 50,
    });
    expect(client.notes.list).toHaveBeenCalledWith({
      project_id: "gw_proj_001",
      author_id: "user_alice",
      is_shared: true,
      tags: ["risk"],
      attached_to_kind: "review",
      attached_to_id: "gw_rev_001",
      has_attachments: true,
      cursor: undefined,
      limit: 50,
    });
  });

  it("returns error result on SDK failure", async () => {
    const client = mockClient({
      notes: {
        create: vi.fn().mockResolvedValue({
          data: null,
          error: { message: "api_key subjects cannot create private notes" },
        }),
      },
    });
    const tools = noteTools(client);
    const result = await tools[0].handler({ body: "secret", is_shared: false });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("api_key");
    // Sanity: error path does not include api key prefix
    expect(result.content[0].text).not.toMatch(/ck_[A-Za-z0-9]/);
  });
});
