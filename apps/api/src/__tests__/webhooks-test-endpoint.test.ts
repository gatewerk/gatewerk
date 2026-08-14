import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// Intercept global fetch so the test endpoint doesn't make real outbound requests.
// The test endpoint uses the module-level `fetch` (globalThis.fetch), so we stub it here.
const mockOutboundFetch = vi.fn();

describe("POST /api/v1/settings/webhooks/test", () => {
  let app: any;
  let client: any;
  let adminToken: string;
  let reviewerToken: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    const db = testDb.db;
    await seedTestProject(db);

    const adminHash = await bcrypt.hash("admin123", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "admin@test-wte.local",
      name: "Test Admin WTE",
      password_hash: adminHash,
      role: "admin",
    });

    const reviewerHash = await bcrypt.hash("reviewer123", 10);
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "reviewer@test-wte.local",
      name: "Test Reviewer WTE",
      password_hash: reviewerHash,
      role: "reviewer",
    });

    app = createApp({ db });

    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test-wte.local", password: "admin123" });
    adminToken = adminLogin.body.token;

    const reviewerLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "reviewer@test-wte.local", password: "reviewer123" });
    reviewerToken = reviewerLogin.body.token;

    // Stub globalThis.fetch for all tests in this suite.
    vi.stubGlobal("fetch", mockOutboundFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (client) await client.close();
  });

  afterEach(() => {
    mockOutboundFetch.mockReset();
  });

  it("returns ok=true with status for a valid public URL + type=generic", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
    expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
    expect(mockOutboundFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockOutboundFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/generic");
    const body = JSON.parse(opts.body);
    // generic format: must have event key at root
    expect(body.event).toBe("review.created");
  });

  it("sends Block Kit shape (no `event` key at root) for type=slack", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/slack",
        type: "slack",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockOutboundFetch).toHaveBeenCalledOnce();
    const [, opts] = mockOutboundFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.event).toBeUndefined(); // not generic shape
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.text).toBeTruthy();
  });

  it("sends Discord embed shape for type=discord", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/discord",
        type: "discord",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockOutboundFetch).toHaveBeenCalledOnce();
    const [, opts] = mockOutboundFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.event).toBeUndefined();
    expect(body.blocks).toBeUndefined();
    expect(typeof body.content).toBe("string");
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(typeof body.embeds[0].color).toBe("number");
  });

  it("sends Telegram MarkdownV2 body (no chat_id in body — supplied via URL) for type=telegram", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://api.telegram.org/bot999:XYZ/sendMessage?chat_id=-100789",
        type: "telegram",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockOutboundFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockOutboundFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot999:XYZ/sendMessage?chat_id=-100789");
    const body = JSON.parse(opts.body);
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.disable_web_page_preview).toBe(true);
    expect(typeof body.text).toBe("string");
    expect(body.chat_id).toBeUndefined();
    expect(body.event).toBeUndefined();
    expect(body.blocks).toBeUndefined();
  });

  it("rejects a private IP URL with 400 invalid_webhook_url", async () => {
    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "http://192.168.1.1/hook",
        type: "generic",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_webhook_url");
    expect(mockOutboundFetch).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin reviewer", async () => {
    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
      });

    expect(res.status).toBe(403);
    expect(mockOutboundFetch).not.toHaveBeenCalled();
  });

  it("returns 422 when webhook_url is missing", async () => {
    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ type: "generic" });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(mockOutboundFetch).not.toHaveBeenCalled();
  });

  it("passes custom Authorization header to outbound fetch", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
        headers: { Authorization: "Bearer abc123" },
      });

    const [, opts] = mockOutboundFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer abc123");
  });

  it("drops hop-by-hop headers but keeps safe custom headers", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
        headers: { "Content-Length": "9999", "X-Custom": "kept" },
      });

    const [, opts] = mockOutboundFetch.mock.calls[0];
    expect(opts.headers["X-Custom"]).toBe("kept");
    expect(opts.headers["content-length"]).toBeUndefined();
    expect(opts.headers["Content-Length"]).toBeUndefined();
  });

  it("Content-Type is always application/json even if admin supplies text/plain", async () => {
    mockOutboundFetch.mockResolvedValueOnce(new Response("ok", { status: 200, statusText: "OK" }));

    await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
        headers: { "Content-Type": "text/plain" },
      });

    const [, opts] = mockOutboundFetch.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("maps TimeoutError to ok=false with descriptive status_text", async () => {
    const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    mockOutboundFetch.mockRejectedValueOnce(timeoutErr);

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(0);
    expect(res.body.status_text).toBe("Request timed out after 10s");
  });

  it("returns structured {ok:false} for an unsupported channel type instead of an opaque 500", async () => {
    // Bypass the Zod enum on the request boundary by sending a value the schema
    // would reject directly — the route's defense-in-depth must still produce a
    // user-friendly result rather than `next(err)` to the global 500 handler.
    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "msteams",
      });

    // Zod blocks this at validation today — assert that's the behavior, AND that
    // if it ever changes to allow the cast through, the structured-error fallback
    // catches it. Both signals are acceptable here: a 422 from the enum OR a 200
    // with ok=false and "Unsupported channel type" status_text.
    if (res.status === 422) {
      expect(res.body.error.code).toBe("validation_failed");
    } else {
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(0);
      expect(res.body.status_text).toMatch(/Unsupported channel type/i);
    }
    expect(mockOutboundFetch).not.toHaveBeenCalled();
  });

  it("reports 3xx as ok=false without following the redirect", async () => {
    mockOutboundFetch.mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      ok: false,
      text: () => Promise.resolve(""),
    });

    const res = await request(app)
      .post("/api/v1/settings/webhooks/test")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        webhook_url: "https://hooks.example.com/generic",
        type: "generic",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(302);
    expect(res.body.status_text).toBe("Found");
    // redirect: "manual" means we never follow — fetch was called exactly once
    expect(mockOutboundFetch).toHaveBeenCalledOnce();
    const [, opts] = mockOutboundFetch.mock.calls[0];
    expect(opts.redirect).toBe("manual");
  });
});
