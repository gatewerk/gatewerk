import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { apiKeys } from "@gatewerk/db/src/schema/index";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";

describe("API Key Authentication", () => {
  let app: ReturnType<typeof createApp>;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    app = createApp({ db });
  });

  it("rejects requests without Authorization header", async () => {
    const res = await request(app).get("/api/v1/templates");
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
  });

  it("rejects requests with invalid API key", async () => {
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", "Bearer gwk_invalid_key_here");
    expect(res.status).toBe(401);
  });

  it("accepts requests with valid API key", async () => {
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
  });

  it("public endpoints remain accessible without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);

    const res2 = await request(app).get("/api/v1");
    expect(res2.status).toBe(200);
  });
});

// Phase 3 — security hardening: expiration + IP allowlist.
// Each test seeds an isolated DB so we can mutate the key's expires_at /
// ip_allowlist without stepping on the shared fixture above.
describe("API Key Security — expiration", () => {
  it("rejects a key whose expires_at is in the past (401 key_expired)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const rawKey = seed.apiKey;
    const hash = createHash("sha256").update(rawKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ expires_at: new Date(Date.now() - 60_000) }) // 1 minute ago
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("key_expired");
  });

  it("accepts a key whose expires_at is in the future", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const rawKey = seed.apiKey;
    const hash = createHash("sha256").update(rawKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ expires_at: new Date(Date.now() + 60 * 60_000) }) // 1 hour from now
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
  });

  it("accepts a key with expires_at = null (default 'never')", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${seed.apiKey}`);

    expect(res.status).toBe(200);
  });
});

describe("API Key Security — IP allowlist", () => {
  it("rejects a request from an IP not in the allowlist (401 ip_not_allowed)", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const rawKey = seed.apiKey;
    const hash = createHash("sha256").update(rawKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ ip_allowlist: ["10.0.0.0/8"] })
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    // supertest connects from 127.0.0.1, which is outside 10.0.0.0/8
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("ip_not_allowed");
  });

  it("accepts a request from an IP inside a CIDR block in the allowlist", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const rawKey = seed.apiKey;
    const hash = createHash("sha256").update(rawKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ ip_allowlist: ["127.0.0.0/8"] }) // supertest connects from 127.0.0.1
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
  });

  it("accepts a request from an exact IP in the allowlist", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const rawKey = seed.apiKey;
    const hash = createHash("sha256").update(rawKey).digest("hex");

    await db
      .update(apiKeys)
      .set({ ip_allowlist: ["127.0.0.1"] })
      .where(eq(apiKeys.key_hash, hash));

    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
  });

  it("accepts any IP when allowlist is null (default 'any IP')", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const app = createApp({ db });
    const res = await request(app)
      .get("/api/v1/templates")
      .set("Authorization", `Bearer ${seed.apiKey}`);

    expect(res.status).toBe(200);
  });
});
