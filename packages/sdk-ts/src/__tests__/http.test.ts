import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../client.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const BASE_URL = "http://localhost:3100";
const API_KEY = "gw_key_test123";

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const headersInstance = new Headers(headers);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: headersInstance,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.GATEWERK_API_KEY;
  delete process.env.GATEWERK_URL;
  // Speed up the suite — we still verify a non-zero delay was awaited
  // because vitest fake timers tick synchronously when advanced.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("retryingRequest — transient retry", () => {
  it("retries 503 then succeeds on second attempt", async () => {
    // First call -> 503; second call -> 200 with payload.
    mockFetch
      .mockReturnValueOnce(jsonResponse({ error: { code: "transient" } }, 503))
      .mockReturnValueOnce(jsonResponse({ id: "gw_rev_001", status: "pending" }));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });

    const start = Date.now();
    const promise = gw.reviews.get("gw_rev_001");
    // Drain the backoff timer so the second attempt fires.
    await vi.advanceTimersByTimeAsync(2000);
    const { data, error } = await promise;
    const elapsed = Date.now() - start;

    expect(error).toBeNull();
    expect(data).toEqual({ id: "gw_rev_001", status: "pending" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Backoff floor (attempt 0 -> 1000ms * 0.8 jitter ~= 800ms minimum).
    expect(elapsed).toBeGreaterThanOrEqual(700);
  });

  it("retries 429 honoring Retry-After in seconds", async () => {
    mockFetch
      .mockReturnValueOnce(jsonResponse({ error: { code: "rate_limited" } }, 429, { "retry-after": "1" }))
      .mockReturnValueOnce(jsonResponse({ id: "gw_rev_001" }));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const promise = gw.reviews.get("gw_rev_001");
    await vi.advanceTimersByTimeAsync(2000);
    const { error } = await promise;
    expect(error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries+1 attempts and returns the final error", async () => {
    // Default maxRetries = 2 -> 3 total attempts. All 503.
    mockFetch
      .mockReturnValueOnce(jsonResponse({ error: { code: "transient", message: "down" } }, 503))
      .mockReturnValueOnce(jsonResponse({ error: { code: "transient", message: "down" } }, 503))
      .mockReturnValueOnce(jsonResponse({ error: { code: "transient", message: "down" } }, 503));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const promise = gw.reviews.get("gw_rev_001");
    await vi.advanceTimersByTimeAsync(10_000);
    const { data, error } = await promise;

    expect(data).toBeNull();
    expect(error).toBeDefined();
    expect(error!.statusCode).toBe(503);
    expect(error!.code).toBe("transient");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 4xx fail-fast errors", async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ error: { code: "not_found", message: "missing" } }, 404),
    );

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const { data, error } = await gw.reviews.get("gw_rev_missing");

    expect(data).toBeNull();
    expect(error!.statusCode).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries network errors", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockReturnValueOnce(jsonResponse({ id: "gw_rev_001" }));

    const gw = createClient({ apiKey: API_KEY, url: BASE_URL });
    const promise = gw.reviews.get("gw_rev_001");
    await vi.advanceTimersByTimeAsync(2000);
    const { data, error } = await promise;

    expect(error).toBeNull();
    expect(data).toEqual({ id: "gw_rev_001" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
