import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { apiKeys } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createHash } from "crypto";

describe("GET /api/v1/auth/key-info", () => {
  let app: any;
  let fullAccessKey: string;
  let scopedKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    fullAccessKey = seed.apiKey; // seeded with ALL_SCOPES post-migration-020

    // Create scoped key
    const scopedRaw = "gwk_scoped_key_info_test_123";
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: seed.project.id,
      key_hash: createHash("sha256").update(scopedRaw).digest("hex"),
      key_prefix: "gwk_scope",
      label: "Scoped key",
      scopes: ["reviews:create", "feedback:read"],
    });
    scopedKey = scopedRaw;

    app = createApp({ db });
  });

  it("returns scopes for a scoped key", async () => {
    const res = await request(app)
      .get("/api/v1/auth/key-info")
      .set({ Authorization: `Bearer ${scopedKey}` });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("key_info");
    expect(res.body.scopes).toEqual(["reviews:create", "feedback:read"]);
    expect(res.body.prefix).toBe("gwk_scope");
  });

  it("returns ALL_SCOPES for a full-access key", async () => {
    // Post-migration-020, the public contract for /key-info returns an
    // explicit scopes array, never null. Legacy NULL rows were backfilled
    // with ALL_SCOPES so existing clients see the same effective access.
    const res = await request(app)
      .get("/api/v1/auth/key-info")
      .set({ Authorization: `Bearer ${fullAccessKey}` });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("key_info");
    expect(Array.isArray(res.body.scopes)).toBe(true);
    expect(res.body.scopes).toEqual(
      expect.arrayContaining([
        "reviews:create",
        "reviews:read",
        "reviews:decide",
        "templates:read",
        "templates:write",
        "feedback:read",
        "audit:read",
        "stats:read",
      ]),
    );
    expect(res.body.prefix).toBe("gwk_test1");
  });

  it("returns 401 for invalid key", async () => {
    const res = await request(app)
      .get("/api/v1/auth/key-info")
      .set({ Authorization: "Bearer gwk_invalid_key_12345" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing auth", async () => {
    const res = await request(app).get("/api/v1/auth/key-info");
    expect(res.status).toBe(401);
  });
});
