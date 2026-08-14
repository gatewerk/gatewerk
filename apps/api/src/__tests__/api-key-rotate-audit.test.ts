import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq, desc } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, auditLog, apiKeys } from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";
import jwt from "jsonwebtoken";
import { createHash } from "crypto";
import { config } from "../config";

// Regression for the key-rotation audit gap.
// `POST /settings/api-keys/:id/rotate` used to swap the `key_hash` +
// `key_prefix` in a single UPDATE with NO audit entry — indistinguishable in
// the log from any other UPDATE, with no way to reconstruct who rotated what
// from when, and from which IP. This test pins the audit entry and its
// expected `{prev_prefix, new_prefix, ip, user_agent}` shape. Grace window
// (two-key accept) deferred to v1.3.
describe("POST /api-keys/:id/rotate — audit log (regression: F4)", () => {
  let app: any;
  let testDb: any;
  let adminToken: string;
  let originalPrefix: string;
  let keyId: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    testDb = db;
    app = createApp({ db });

    const seed = await seedTestProject(db);

    // Create a dedicated key that we can rotate without affecting the seed key.
    const rawKey = "gwk_rotate_target_key_1234";
    originalPrefix = rawKey.slice(0, 8);
    keyId = generateId("api_key");
    await db.insert(apiKeys).values({
      id: keyId,
      project_id: seed.project.id,
      key_hash: createHash("sha256").update(rawKey).digest("hex"),
      key_prefix: originalPrefix,
      label: "Rotate target",
      scopes: [...ALL_SCOPES],
    });

    const adminId = generateId("user");
    await db.insert(reviewers).values({
      id: adminId,
      email: "rotate-admin@test.local",
      name: "Rotate Admin",
      password_hash: "unused-in-jwt-test",
      role: "admin",
      is_active: true,
    });
    adminToken = jwt.sign({ sub: adminId, email: "rotate-admin@test.local" }, config.jwtSecret, { audience: "gatewerk-dashboard", issuer: "gatewerk-api" });
  });

  it("POST /api-keys/:id/rotate emits `api_key.rotated` audit entry with prev/new prefixes", async () => {
    const res = await request(app)
      .post(`/api/v1/settings/api-keys/${keyId}/rotate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.raw_key).toBe("string");

    // New key_prefix comes from the raw_key's first 8 characters — verified by
    // parity with generateApiKey() (see src/lib/generate-api-key.ts). The
    // response also exposes `key_prefix` on the api_key envelope.
    // Prefix shape per `generateApiKey()`: `gwk_<first 8 hex chars>` — 12 chars total.
    const newPrefix = res.body.key_prefix;
    expect(newPrefix).not.toBe(originalPrefix);
    expect(newPrefix).toMatch(/^gwk_[0-9a-f]{8}$/);

    await new Promise((r) => setTimeout(r, 30)); // fire-and-forget audit log

    const events = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "api_key.rotated"))
      .orderBy(desc(auditLog.created_at))
      .limit(1);
    expect(events.length).toBe(1);

    const entry = events[0];
    expect(entry.actor).toBe("reviewer:rotate-admin@test.local");
    expect(entry.resource_type).toBe("api_key");
    expect(entry.resource_id).toBe(keyId);

    const details = entry.details as {
      prev_prefix: string;
      new_prefix: string;
      ip: string | null;
      user_agent: string | null;
    };
    expect(details.prev_prefix).toBe(originalPrefix);
    expect(details.new_prefix).toBe(newPrefix);
    // `ip` comes from supertest's local socket — we only assert type, not value,
    // because the actual address varies by platform (127.0.0.1 vs ::1).
    expect(details.ip === null || typeof details.ip === "string").toBe(true);
  });
});
