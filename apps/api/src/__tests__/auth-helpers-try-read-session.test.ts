import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { tryReadMainAppSession } from "../lib/auth-helpers";
import { config } from "../config";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
} from "../services/token-recipient-session";

/**
 * Direct unit coverage for tryReadMainAppSession. The integration tests
 * (account-tier-recipient-flow) exercise the helper through the recipient
 * flow; these cases pin the helper contract independently so a refactor
 * cannot silently flip a null-return into a throw or accept a token that
 * should fail closed (RFC 7519 §4.1.3 audience isolation, deactivated
 * user, stale tokenVersion, malformed Authorization header).
 */

function makeReq(headerValue?: string) {
  return { headers: headerValue ? { authorization: headerValue } : {} };
}

describe("tryReadMainAppSession", () => {
  let db: any;
  let client: any;
  let activeUserId: string;
  let deactivatedUserId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);

    activeUserId = generateId("user");
    await db.insert(reviewers).values({
      id: activeUserId,
      email: "active@try-read-session.local",
      name: "Active",
      password_hash: await bcrypt.hash("password123", 10),
      role: "reviewer",
      is_active: true,
      token_version: 0,
    });

    deactivatedUserId = generateId("user");
    await db.insert(reviewers).values({
      id: deactivatedUserId,
      email: "deactivated@try-read-session.local",
      name: "Deactivated",
      password_hash: await bcrypt.hash("password123", 10),
      role: "reviewer",
      is_active: false,
      token_version: 0,
    });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("T1: returns null on missing Authorization header", async () => {
    const result = await tryReadMainAppSession(makeReq(), db);
    expect(result).toBeNull();
  });

  it("T2: returns null when Authorization is missing the 'Bearer ' prefix", async () => {
    const result = await tryReadMainAppSession(makeReq("Basic abc123"), db);
    expect(result).toBeNull();
  });

  it("T3: returns null on 'Bearer ' with empty token", async () => {
    const result = await tryReadMainAppSession(makeReq("Bearer "), db);
    expect(result).toBeNull();
  });

  it("T4: returns null on a malformed JWT (3 dots, garbage payload)", async () => {
    const result = await tryReadMainAppSession(
      makeReq("Bearer not.a.valid.jwt"),
      db,
    );
    expect(result).toBeNull();
  });

  it("T5: returns null on a JWT signed with the wrong key", async () => {
    const wrongKey = `${config.jwtSecret}-mutated-for-test`;
    const tampered = jwt.sign(
      { sub: activeUserId, email: "active@try-read-session.local", tokenVersion: 0 },
      wrongKey,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const result = await tryReadMainAppSession(
      makeReq(`Bearer ${tampered}`),
      db,
    );
    expect(result).toBeNull();
  });

  it("T6: returns null on a JWT carrying audience: token-recipient (RFC 7519 §4.1.3 isolation)", async () => {
    const recipientJwt = jwt.sign(
      { sub: activeUserId, email: "active@try-read-session.local", tokenVersion: 0 },
      config.jwtSecret,
      {
        algorithm: "HS256",
        audience: RECIPIENT_SESSION_AUDIENCE,
        issuer: RECIPIENT_SESSION_ISSUER,
        expiresIn: "30m",
      },
    );
    const result = await tryReadMainAppSession(
      makeReq(`Bearer ${recipientJwt}`),
      db,
    );
    expect(result).toBeNull();
  });

  it("T7: returns null on a JWT for a deactivated user (is_active=false)", async () => {
    const tok = jwt.sign(
      { sub: deactivatedUserId, email: "deactivated@try-read-session.local", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const result = await tryReadMainAppSession(makeReq(`Bearer ${tok}`), db);
    expect(result).toBeNull();
  });

  it("T8: returns null on a JWT for a user that no longer exists", async () => {
    const ghostId = generateId("user");
    const tok = jwt.sign(
      { sub: ghostId, email: "ghost@try-read-session.local", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const result = await tryReadMainAppSession(makeReq(`Bearer ${tok}`), db);
    expect(result).toBeNull();
  });

  it("T9: returns null on a JWT with a stale tokenVersion", async () => {
    // Bump server-side tokenVersion AFTER signing — simulates a force-logout
    // (password rotation, admin revoke). Subsequent verify must fail closed.
    const tok = jwt.sign(
      { sub: activeUserId, email: "active@try-read-session.local", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    await db
      .update(reviewers)
      .set({ token_version: 99 })
      .where(eq(reviewers.id, activeUserId));
    const result = await tryReadMainAppSession(makeReq(`Bearer ${tok}`), db);
    expect(result).toBeNull();
    // Restore for any downstream test sharing this fixture.
    await db
      .update(reviewers)
      .set({ token_version: 0 })
      .where(eq(reviewers.id, activeUserId));
  });

  it("T10: returns SessionResult on a valid main-app JWT", async () => {
    const tok = jwt.sign(
      { sub: activeUserId, email: "active@try-read-session.local", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const result = await tryReadMainAppSession(makeReq(`Bearer ${tok}`), db);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(activeUserId);
    expect(result?.email).toBe("active@try-read-session.local");
  });
});
