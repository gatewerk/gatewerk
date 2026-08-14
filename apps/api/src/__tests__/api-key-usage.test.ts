import { describe, it, expect } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { apiKeys, apiKeyUsage, reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";

// Poll the usage table for up to ~200ms. `res.on("finish")` fires synchronously
// with the response end, but the fire-and-forget INSERT is a microtask — a
// single setImmediate tick is usually enough, but we give more headroom on
// slow CI.
async function waitForUsageRow(db: any, apiKeyId: string, expectCount = 1, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.api_key_id, apiKeyId));
    if (rows.length >= expectCount) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  const rows = await db
    .select()
    .from(apiKeyUsage)
    .where(eq(apiKeyUsage.api_key_id, apiKeyId));
  return rows;
}

async function adminToken(app: ReturnType<typeof createApp>, db: any) {
  const email = "admin@test.local";
  await db.insert(reviewers).values({
    id: generateId("user"),
    email,
    name: "Admin",
    password_hash: await bcrypt.hash("admin123", 10),
    role: "admin",
  });
  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "admin123" });
  return login.body.token as string;
}

describe("API key usage logging — write path", () => {
  it("logs a row after a successful authed request (dualAuth)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${seed.apiKey}`);
    expect(res.status).toBe(200);

    const rows = await waitForUsageRow(db, key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe("/api/v1/templates");
    expect(rows[0].method).toBe("GET");
    expect(rows[0].status_code).toBe(200);
  });

  it("captures the real status code for non-200 handler responses", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    // Unknown template slug → 404 from the review-create path (dualAuth-protected).
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${seed.apiKey}`)
      .send({ template: "no-such-template", payload: {} });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await waitForUsageRow(db, key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status_code).toBe(res.status);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].endpoint).toBe("/api/v1/reviews");
  });

  it("does NOT log usage for requests with an invalid API key", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", "Bearer gwk_not_a_real_key");
    expect(res.status).toBe(401);

    // Give any stray finish hook a moment to fire, then assert silence.
    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.select().from(apiKeyUsage).where(eq(apiKeyUsage.api_key_id, key.id));
    expect(rows).toHaveLength(0);
  });

  it("does NOT log usage for an expired key (auth fails before hook attaches)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    await db
      .update(apiKeys)
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where(eq(apiKeys.key_hash, hash));
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${seed.apiKey}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("key_expired");

    await new Promise((r) => setTimeout(r, 50));
    const rows = await db.select().from(apiKeyUsage).where(eq(apiKeyUsage.api_key_id, key.id));
    expect(rows).toHaveLength(0);
  });

  it("logs once per request, not per middleware hop (apiKeyAuth-only routes)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    // /feedback is mounted under apiKeyAuth (not dualAuth) — different entry point.
    const res = await request(app)
      .get("/api/v1/feedback")
      .set("Authorization", `Bearer ${seed.apiKey}`);
    expect(res.status).toBeLessThan(500);

    const rows = await waitForUsageRow(db, key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe("/api/v1/feedback");
  });

  it("strips query string from endpoint (stable aggregation key)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const app = createApp({ db });
    await request(app)
      .get("/api/v1/templates?limit=5&cursor=abc")
      .set("Authorization", `Bearer ${seed.apiKey}`);

    const rows = await waitForUsageRow(db, key.id);
    expect(rows[0].endpoint).toBe("/api/v1/templates");
  });
});

describe("GET /api/v1/settings/api-keys/:id/usage — read path", () => {
  it("returns requests_today count and recent_requests list", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    // Seed three usage rows.
    await db.insert(apiKeyUsage).values([
      { api_key_id: key.id, endpoint: "/api/v1/reviews", method: "POST", status_code: 201 },
      { api_key_id: key.id, endpoint: "/api/v1/reviews", method: "GET", status_code: 200 },
      { api_key_id: key.id, endpoint: "/api/v1/templates", method: "GET", status_code: 200 },
    ]);

    const app = createApp({ db });
    const token = await adminToken(app, db);
    const res = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.requests_today).toBe(3);
    expect(res.body.recent_requests).toHaveLength(3);
    expect(res.body.sparkline.length).toBeGreaterThanOrEqual(1);
    expect(res.body.rate_limit_per_hour).toBeNull();
    expect(res.body.rate_limit_used_pct).toBeNull();
  });

  it("computes rate_limit_used_pct when rate_limit_per_hour is set", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    await db
      .update(apiKeys)
      .set({ rate_limit_per_hour: 10 })
      .where(eq(apiKeys.key_hash, hash));
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    // 5 requests in the last hour.
    await db.insert(apiKeyUsage).values(
      Array.from({ length: 5 }, () => ({
        api_key_id: key.id,
        endpoint: "/api/v1/reviews",
        method: "POST",
        status_code: 201,
      })),
    );

    const app = createApp({ db });
    const token = await adminToken(app, db);
    const res = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.rate_limit_per_hour).toBe(10);
    expect(res.body.rate_limit_used_pct).toBe(50); // 5/10 × 100
  });

  it("honors recent_limit query param (bounded 1..100)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    await db.insert(apiKeyUsage).values(
      Array.from({ length: 20 }, () => ({
        api_key_id: key.id,
        endpoint: "/api/v1/reviews",
        method: "POST",
        status_code: 201,
      })),
    );

    const app = createApp({ db });
    const token = await adminToken(app, db);

    const resDefault = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage`)
      .set("Authorization", `Bearer ${token}`);
    expect(resDefault.body.recent_requests).toHaveLength(10);

    const resHigh = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage?recent_limit=15`)
      .set("Authorization", `Bearer ${token}`);
    expect(resHigh.body.recent_requests).toHaveLength(15);

    const resClamp = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage?recent_limit=9999`)
      .set("Authorization", `Bearer ${token}`);
    expect(resClamp.body.recent_requests.length).toBeLessThanOrEqual(20); // capped at available rows
  });

  it("recent_requests is ordered most-recent-first", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const hash = createHash("sha256").update(seed.apiKey).digest("hex");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.key_hash, hash)).limit(1);

    const now = Date.now();
    await db.insert(apiKeyUsage).values([
      { api_key_id: key.id, endpoint: "/a", method: "GET", status_code: 200, created_at: new Date(now - 3000) },
      { api_key_id: key.id, endpoint: "/b", method: "GET", status_code: 200, created_at: new Date(now - 1000) },
      { api_key_id: key.id, endpoint: "/c", method: "GET", status_code: 200, created_at: new Date(now - 2000) },
    ]);

    const app = createApp({ db });
    const token = await adminToken(app, db);
    const res = await request(app)
      .get(`/api/v1/settings/api-keys/${key.id}/usage`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.recent_requests.map((r: any) => r.endpoint)).toEqual(["/b", "/c", "/a"]);
  });

  it("returns 404 for a key that does not belong to the caller's project", async () => {
    const { db } = await createTestDb();
    await seedTestProject(db);
    const app = createApp({ db });
    const token = await adminToken(app, db);
    const res = await request(app)
      .get("/api/v1/settings/api-keys/api_key_nonexistent/usage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("api_key_not_found");
  });
});
