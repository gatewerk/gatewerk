/**
 * End-to-end test for the bcrypt → argon2id transparent rehash-on-login upgrade.
 *
 * Strategy:
 *  1. Seed a reviewer with a legacy bcrypt-format hash.
 *  2. Login — assert success (bcrypt-fallback path in verifyPassword).
 *  3. Poll the DB until the hash is upgraded to argon2id (fire-and-forget side-effect).
 *  4. Login again with same password — assert success (argon2id path this time).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createAuditService } from "../services/audit";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { eq } from "drizzle-orm";

describe("rehash-on-login: bcrypt → argon2id transparent upgrade", () => {
  let app: any;
  let db: any;
  let client: any;
  let userId: string;
  let auditService: ReturnType<typeof createAuditService>;
  const password = "TestPass123!";
  const email = "bcryptrehash@example.com";

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    await seedTestProject(db);

    // Seed user with legacy bcrypt hash
    userId = generateId("user");
    const legacyHash = await bcrypt.hash(password, 10);
    await db.insert(reviewers).values({
      id: userId,
      email,
      name: "Bcrypt Rehash Test",
      password_hash: legacyHash,
      role: "reviewer",
      is_active: true,
    });

    // Inject auditService so we can spy on it (I4).
    auditService = createAuditService(db);
    app = createApp({ db, auditService });
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  });

  it("legacy bcrypt-hashed user logs in, hash is upgraded to argon2id, next login succeeds", async () => {
    // Step 1: confirm the hash is bcrypt before login
    const [beforeLogin] = await db
      .select({ password_hash: reviewers.password_hash })
      .from(reviewers)
      .where(eq(reviewers.id, userId));
    expect(beforeLogin.password_hash.startsWith("$2")).toBe(true);

    // I4: spy on auditService.log before login so we can assert password.rehashed emission.
    // The hash flip (DB update) and the audit emission are independent fire-and-forget
    // side-effects; both must be asserted to prevent silent regression.
    const auditLogSpy = vi.spyOn(auditService, "log");

    // Step 2: login — assert success (bcrypt-fallback path)
    const login1 = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(login1.status).toBe(200);
    expect(login1.body.token).toBeDefined();

    // Step 3: poll until the fire-and-forget rehash has flipped the DB hash to argon2id.
    // The rehash is launched in a detached promise inside the login handler.
    // We poll with short intervals — empirically it completes within 1-2 seconds.
    const start = Date.now();
    const timeout = 8000;
    const interval = 100;
    let upgraded = false;
    while (Date.now() - start < timeout) {
      const [row] = await db
        .select({ password_hash: reviewers.password_hash })
        .from(reviewers)
        .where(eq(reviewers.id, userId));
      if (row.password_hash.startsWith("$argon2id$")) {
        upgraded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    expect(upgraded).toBe(true);

    // I4: at this point the fire-and-forget has completed (hash is in DB).
    // Assert that password.rehashed was also emitted to the audit log.
    expect(auditLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "password.rehashed",
        actor: userId,
        resource_type: "reviewer",
      }),
    );

    // Step 4: login again — this time the argon2id path is exercised
    const login2 = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password });
    expect(login2.status).toBe(200);
    expect(login2.body.token).toBeDefined();
  });
});
