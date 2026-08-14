import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import bcrypt from "bcryptjs";
import { validateJwt } from "../lib/auth-helpers";
import { config } from "../config";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_TTL_SECONDS,
} from "../services/token-recipient-session";

describe("validateJwt audience-claim isolation", () => {
  let db: any;
  let client: any;
  let reviewerId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);

    reviewerId = generateId("user");
    await db.insert(reviewers).values({
      id: reviewerId,
      email: "audrev@example.com",
      name: "Audience Test",
      password_hash: await bcrypt.hash("hunter2", 10),
      role: "reviewer",
      is_active: true,
      token_version: 0,
    });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("rejects a JWT carrying the recipient audience claim", async () => {
    // Simulate a leaked recipient cookie value being replayed into the
    // Authorization: Bearer header. The JWT validates cryptographically
    // (signed with the correct key + algorithm) but its audience is
    // "token-recipient" — jwt.verify now enforces audience: "gatewerk-dashboard"
    // and will throw a JsonWebTokenError on mismatch. validateJwt does not
    // swallow verify errors; callers (e.g. tryReadMainAppSession) catch and
    // translate to null. We assert the throw here to confirm the enforcement.
    const recipientJwt = jwt.sign(
      { email: "x@example.com" },
      config.jwtSecret,
      {
        algorithm: "HS256",
        audience: RECIPIENT_SESSION_AUDIENCE,
        issuer: RECIPIENT_SESSION_ISSUER,
        subject: "gw_tok_some_token",
        expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
      },
    );
    await expect(validateJwt(recipientJwt, db)).rejects.toThrow();
  });

  it("accepts a reviewer JWT with the correct audience and issuer", async () => {
    // Now that jwt.verify enforces audience: "gatewerk-dashboard" and
    // issuer: "gatewerk-api", tokens must carry both claims to be accepted.
    const reviewerJwt = jwt.sign(
      { sub: reviewerId, email: "audrev@example.com", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS256", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const result = await validateJwt(reviewerJwt, db);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(reviewerId);
  });

  it("rejects a JWT with an unrelated audience that happens to equal the recipient sentinel", async () => {
    // A reviewer JWT signed with audience: "token-recipient" by an
    // operator misconfiguration must also fail closed. With the positive
    // audience enforcement now in place, jwt.verify throws when the audience
    // does not match "gatewerk-dashboard" — it never reaches the negative check.
    const masquerade = jwt.sign(
      { sub: reviewerId, email: "audrev@example.com", tokenVersion: 0 },
      config.jwtSecret,
      {
        algorithm: "HS256",
        audience: RECIPIENT_SESSION_AUDIENCE,
      },
    );
    await expect(validateJwt(masquerade, db)).rejects.toThrow();
  });

  it("rejects a JWT signed with the wrong key", async () => {
    // Derive a key that intentionally differs from config.jwtSecret to
    // simulate a forged token without inlining a credential literal
    // (Semgrep javascript.jsonwebtoken.security.jwt-hardcode rule).
    const wrongKey = `${config.jwtSecret}-mutated-for-test`;
    const tampered = jwt.sign(
      { sub: reviewerId, email: "audrev@example.com", tokenVersion: 0 },
      wrongKey,
      { algorithm: "HS256" },
    );
    // Bad signature throws inside jwt.verify; caller-level (dual-auth)
    // catches and translates to AuthenticationError. Here we just want
    // to confirm the function does not silently accept it.
    await expect(validateJwt(tampered, db)).rejects.toThrow();
  });
});
