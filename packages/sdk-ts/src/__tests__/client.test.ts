import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { createClient } from "../client.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const BASE_URL = "http://localhost:3100";
const API_KEY = "gw_key_test123";

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.GATEWERK_API_KEY;
  delete process.env.GATEWERK_URL;
});

describe("createClient", () => {
  it("creates a client with explicit config", () => {
    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    expect(gw.reviews).toBeDefined();
    expect(gw.feedback).toBeDefined();
    expect(gw.webhooks).toBeDefined();
    expect(gw.templates).toBeDefined();
    expect(gw.chains).toBeDefined();
    expect(gw.notes).toBeDefined();
  });

  it("falls back to env vars", () => {
    process.env.GATEWERK_API_KEY = API_KEY;
    process.env.GATEWERK_URL = BASE_URL;
    const gw = createClient();
    expect(gw.reviews).toBeDefined();
  });

  it("throws if no API key provided", () => {
    expect(() => createClient({ url: BASE_URL })).toThrow("API key is required");
  });
});

describe("gw.reviews.create()", () => {
  it("returns { data, error: null } on success", async () => {
    const reviewData = { id: "gw_rev_001", object: "review", status: "pending" };
    mockFetch.mockReturnValueOnce(jsonResponse(reviewData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.create({
      template: "deploy",
      payload: { service: "api" },
      callback_url: "https://example.com/webhook",
    });

    expect(error).toBeNull();
    expect(data).toEqual(reviewData);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/reviews`);
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("returns { data: null, error } on API error", async () => {
    const errorData = {
      error: {
        type: "invalid_request",
        code: "template_not_found",
        message: "Template 'foo' not found",
        param: "template",
      },
    };
    mockFetch.mockReturnValueOnce(jsonResponse(errorData, 400));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.create({
      template: "foo",
      payload: {},
      callback_url: "https://example.com/webhook",
    });

    expect(data).toBeNull();
    expect(error).toBeDefined();
    expect(error!.code).toBe("template_not_found");
    expect(error!.message).toBe("Template 'foo' not found");
    expect(error!.statusCode).toBe(400);
  });
});

describe("gw.reviews.get()", () => {
  it("returns review by ID", async () => {
    const reviewData = { id: "gw_rev_001", object: "review", status: "decided" };
    mockFetch.mockReturnValueOnce(jsonResponse(reviewData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.get("gw_rev_001");

    expect(error).toBeNull();
    expect(data).toEqual(reviewData);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001`);
  });
});

describe("gw.reviews.list()", () => {
  it("returns paginated list", async () => {
    const listData = { object: "list", data: [], has_more: false };
    mockFetch.mockReturnValueOnce(jsonResponse(listData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.list({ status: "pending" });

    expect(error).toBeNull();
    expect(data).toEqual(listData);
    expect(mockFetch.mock.calls[0][0]).toContain("status=pending");
  });
});

describe("gw.reviews.decide()", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits decision", async () => {
    const decidedData = { id: "gw_rev_001", object: "review", status: "decided", decision: "approved" };
    mockFetch.mockReturnValueOnce(jsonResponse(decidedData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.decide("gw_rev_001", {
      decision: "approved",
      feedback: "Looks good",
    });

    expect(error).toBeNull();
    expect(data!.decision).toBe("approved");
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/decide`);
  });
});

describe("gw.feedback.query()", () => {
  it("returns feedback items", async () => {
    const feedbackData = { object: "list", data: [], has_more: false };
    mockFetch.mockReturnValueOnce(jsonResponse(feedbackData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.feedback.query({ template: "deploy" });

    expect(error).toBeNull();
    expect(data).toEqual(feedbackData);
    expect(mockFetch.mock.calls[0][0]).toContain("template=deploy");
  });
});

describe("gw.webhooks.verify()", () => {
  it("verifies a valid signature (sha256=<hex> over raw body)", () => {
    const secret = "test-secret";
    const body = JSON.stringify({ review_id: "gw_rev_001", decision: "approved" });
    const sig = createHmac("sha256", secret).update(body).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    const header = `sha256=${sig}`;

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const result = gw.webhooks.verify(body, header, secret);

    expect(result.review_id).toBe("gw_rev_001");
    expect(result.decision).toBe("approved");
  });

  it("rejects invalid signature", () => {
    const body = JSON.stringify({ review_id: "gw_rev_001" });
    const header = `sha256=${"0".repeat(64)}`;

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    expect(() => gw.webhooks.verify(body, header, "secret")).toThrow("verification failed");
  });

  it("rejects legacy t=...,v1=... format", () => {
    const body = JSON.stringify({ review_id: "gw_rev_001" });
    const legacy = `t=1700000000,v1=${"0".repeat(64)}`;

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    expect(() => gw.webhooks.verify(body, legacy, "secret")).toThrow("Invalid signature header format");
  });
});

describe("gw.chains.create()", () => {
  it("posts to /api/v1/chain-runs and returns the chain run", async () => {
    const chainData = {
      object: "chain_run",
      id: "gw_chain_001",
      project_id: "gw_proj_001",
      template_id: null,
      name: null,
      mode: "sequential",
      rejection_policy: "terminate",
      status: "active",
      metadata: null,
      created_by: "agent:gw_key_t",
      created_at: "2026-05-03T20:00:00.000Z",
      completed_at: null,
      steps: [],
      step_1_review_id: "gw_rev_step1",
    };
    mockFetch.mockReturnValueOnce(jsonResponse(chainData, 201));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.chains.create({
      definition: {
        version: "1.0",
        mode: "sequential",
        steps: [
          {
            id: "step1",
            template: "deploy",
            assignee: { kind: "role", role: "admin" },
          },
        ],
      },
      initial_payload: { service: "api" },
    });

    expect(error).toBeNull();
    expect(data).toEqual(chainData);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/chain-runs`);
    expect(init.method).toBe("POST");
  });
});

describe("gw.chains.get()", () => {
  it("fetches a chain run by id", async () => {
    const chainData = { object: "chain_run", id: "gw_chain_001", status: "completed", steps: [] };
    mockFetch.mockReturnValueOnce(jsonResponse(chainData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.chains.get("gw_chain_001");

    expect(error).toBeNull();
    expect(data).toEqual(chainData);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/chain-runs/gw_chain_001`);
  });
});

describe("gw.chains.getForReview()", () => {
  it("fetches chain context for a review", async () => {
    const chainData = {
      object: "chain_run",
      id: "gw_chain_001",
      status: "active",
      steps: [],
      current_step_number: 2,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(chainData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data } = await gw.chains.getForReview("gw_rev_001");
    expect(data).toEqual(chainData);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/chain`);
  });
});

describe("gw.notes.create()", () => {
  it("posts to /api/v1/notes and returns the created note", async () => {
    const noteData = {
      id: "gw_note_001",
      project_id: "gw_proj_001",
      author_id: null,
      author_display_fallback: "api_key:abcd1234",
      body: "Deploy looks safe.",
      tags: ["deploy"],
      is_shared: true,
      attachments: [],
      created_at: "2026-05-03T20:00:00.000Z",
      updated_at: "2026-05-03T20:00:00.000Z",
    };
    mockFetch.mockReturnValueOnce(jsonResponse(noteData, 201));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.notes.create({
      project_id: "gw_proj_001",
      body: "Deploy looks safe.",
      tags: ["deploy"],
      is_shared: true,
    });

    expect(error).toBeNull();
    expect(data).toEqual(noteData);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/notes`);
    expect(init.method).toBe("POST");
  });
});

describe("gw.notes.list()", () => {
  it("threads project_id and tags into the query string", async () => {
    const listData = { items: [], total: 0, has_more: false };
    mockFetch.mockReturnValueOnce(jsonResponse(listData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.notes.list({
      project_id: "gw_proj_001",
      tags: ["deploy", "ops"],
      is_shared: true,
    });

    expect(error).toBeNull();
    expect(data).toEqual(listData);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("project_id=gw_proj_001");
    expect(url).toContain("tags=deploy");
    expect(url).toContain("tags=ops");
    expect(url).toContain("is_shared=true");
  });
});

describe("gw.notes.delete()", () => {
  it("returns success on 204 No Content", async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve({
        ok: true,
        status: 204,
        statusText: "No Content",
        json: () => Promise.reject(new Error("no body")),
        text: () => Promise.resolve(""),
      }),
    );

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { error } = await gw.notes.delete("gw_note_001");
    expect(error).toBeNull();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/notes/gw_note_001`);
    expect(init.method).toBe("DELETE");
  });
});

describe("gw.reviews.cancelRequest()", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the cancel-request endpoint", async () => {
    const reviewData = { id: "gw_rev_001", status: "pending" };
    mockFetch.mockReturnValueOnce(jsonResponse(reviewData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.cancelRequest("gw_rev_001");
    expect(error).toBeNull();
    expect(data).toEqual(reviewData);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/cancel-request`);
  });
});

describe("gw.reviews.versions()", () => {
  it("fetches version history", async () => {
    const versions = { items: [{ id: "gw_ver_1", review_id: "gw_rev_001", version: 1, payload: {}, edited_by: null, created_at: "2026-05-03T20:00:00.000Z" }] };
    mockFetch.mockReturnValueOnce(jsonResponse(versions));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.versions("gw_rev_001");
    expect(error).toBeNull();
    expect(data).toEqual(versions);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/versions`);
  });
});

describe("gw.reviews.createToken()", () => {
  it("posts to the token endpoint with optional expiryHours", async () => {
    const tokenData = { token: "gw_tok_xyz", url: "http://localhost:3100/r/abc", expires_at: "2026-05-04T20:00:00.000Z" };
    mockFetch.mockReturnValueOnce(jsonResponse(tokenData, 201));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.createToken("gw_rev_001", { expiryHours: 24 });
    expect(error).toBeNull();
    expect(data).toEqual(tokenData);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/token`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ expiryHours: 24 });
  });
});
