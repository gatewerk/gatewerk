import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../client.js";

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

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  vi.restoreAllMocks();
});

// T1: reviews.action() POSTs correct URL + body
describe("gw.reviews.action()", () => {
  it("T1: POSTs correct URL and body for action_id=approve", async () => {
    const actionData = { id: "gw_rev_001", status: "decided", decision: "approved" };
    mockFetch.mockReturnValueOnce(jsonResponse(actionData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.action("gw_rev_001", { action_id: "approve" });

    expect(error).toBeNull();
    expect(data).toEqual(actionData);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/api/v1/reviews/gw_rev_001/action`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ action_id: "approve" });
  });

  // T2: propagates non-required fields (feedback, edited_payload, version)
  it("T2: propagates optional fields in request body", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ id: "gw_rev_001", status: "decided" }));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    await gw.reviews.action("gw_rev_001", {
      action_id: "approve",
      feedback: "Looks good",
      edited_payload: { subject: "Updated" },
      version: 3,
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.action_id).toBe("approve");
    expect(body.feedback).toBe("Looks good");
    expect(body.edited_payload).toEqual({ subject: "Updated" });
    expect(body.version).toBe(3);
  });

  // T2b: optional fields are NOT sent when omitted (no ?? null drift)
  it("T2b: omits feedback/edited_payload/version when not provided", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ id: "gw_rev_001", status: "decided" }));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    await gw.reviews.action("gw_rev_001", { action_id: "approve" });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect("feedback" in body).toBe(false);
    expect("edited_payload" in body).toBe(false);
    expect("version" in body).toBe(false);
  });

  // T3: returns Result<> envelope on success
  it("T3: returns Result envelope with data on success", async () => {
    const actionData = { id: "gw_rev_001", status: "decided" };
    mockFetch.mockReturnValueOnce(jsonResponse(actionData));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const result = await gw.reviews.action("gw_rev_001", { action_id: "reject" });

    expect(result.data).toEqual(actionData);
    expect(result.error).toBeNull();
  });

  // T4: returns Result<> envelope on error
  it("T4: returns Result envelope with error on failure", async () => {
    const errorData = {
      error: {
        type: "invalid_request",
        code: "action_not_allowed",
        message: "Action not allowed in current status",
        param: "action_id",
      },
    };
    mockFetch.mockReturnValueOnce(jsonResponse(errorData, 400));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const result = await gw.reviews.action("gw_rev_001", { action_id: "approve" });

    expect(result.data).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("action_not_allowed");
    expect(result.error!.statusCode).toBe(400);
  });


  // T9: 401 returned when called with api-key auth (session-auth-only contract)
  it("T9: returns Result error on 401 (api-key auth not supported)", async () => {
    const errorBody = { error: { type: "authentication_error", code: "session_required", message: "POST /reviews/:id/action requires a reviewer session." } };
    mockFetch.mockReturnValueOnce(jsonResponse(errorBody, 401));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const result = await gw.reviews.action("gw_rev_001", { action_id: "approve" });

    expect(result.data).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error!.statusCode).toBe(401);
    expect(result.error!.message).toContain("session");
  });
});

// T5-T8: deprecation warnings — use vi.resetModules() to reset Set state per test
describe("deprecation warnings", () => {
  afterEach(() => {
    vi.resetModules();
  });

  // T5: reviews.decide() emits exactly one console.warn containing "deprecated" + "action"
  it("T5: reviews.decide() emits deprecation warning exactly once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockReturnValue(jsonResponse({ id: "gw_rev_001" }));

    // Re-import to get a fresh module with empty Set
    const { createClient: freshCreateClient } = await import("../client");
    const gw = freshCreateClient({ apiKey: API_KEY, url: BASE_URL });

    await gw.reviews.decide("gw_rev_001", { decision: "approved" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("deprecated");
    expect(warnSpy.mock.calls[0][0]).toContain("action");

    // Second call must NOT re-emit
    await gw.reviews.decide("gw_rev_001", { decision: "approved" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // T6: reviews.retry() emits deprecation warning once
  it("T6: reviews.retry() emits deprecation warning exactly once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockReturnValue(jsonResponse({ id: "gw_rev_001" }));

    const { createClient: freshCreateClient } = await import("../client");
    const gw = freshCreateClient({ apiKey: API_KEY, url: BASE_URL });

    await gw.reviews.retry("gw_rev_001", { feedback: "Try again" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("retry");

    await gw.reviews.retry("gw_rev_001", {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // T7: reviews.cancelRequest() emits deprecation warning once
  it("T7: reviews.cancelRequest() emits deprecation warning exactly once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockReturnValue(jsonResponse({ id: "gw_rev_001" }));

    const { createClient: freshCreateClient } = await import("../client");
    const gw = freshCreateClient({ apiKey: API_KEY, url: BASE_URL });

    await gw.reviews.cancelRequest("gw_rev_001");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("cancelRequest");

    await gw.reviews.cancelRequest("gw_rev_001");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // T8: Independent methods each warn once (distinct keys in Set)
  it("T8: decide AND retry both warn independently (distinct Set keys)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockReturnValue(jsonResponse({ id: "gw_rev_001" }));

    const { createClient: freshCreateClient } = await import("../client");
    const gw = freshCreateClient({ apiKey: API_KEY, url: BASE_URL });

    await gw.reviews.decide("gw_rev_001", { decision: "approved" });
    await gw.reviews.retry("gw_rev_001", {});

    expect(warnSpy).toHaveBeenCalledTimes(2);
    const messages = warnSpy.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes("decide"))).toBe(true);
    expect(messages.some((m) => m.includes("retry"))).toBe(true);
  });
});
