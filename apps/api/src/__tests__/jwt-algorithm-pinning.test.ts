import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";

// Locks §7 G3: validateJwt pins algorithms:["HS256"]. Without pinning,
// jsonwebtoken's verify derives the allowed algorithm set from the secret
// type (HMAC family for a string secret) — so a token signed with HS384
// under the same shared secret would still verify. Pinning aligns the
// verify side with routes/auth.ts's issuance (default HS256).
describe("validateJwt algorithm pinning (§7 G3)", () => {
  let app: any;
  let reviewerId: string;
  let reviewerEmail = "alg-pin@test.local";

  beforeAll(async () => {
    const { db } = await createTestDb();
    await seedTestProject(db);

    const [row] = await db
      .insert(reviewers)
      .values({
        id: generateId("user"),
        email: reviewerEmail,
        name: "Alg Pin",
        password_hash: await bcrypt.hash("pass1234", 10),
        role: "admin",
      })
      .returning();
    reviewerId = row.id;

    app = createApp({ db });
  });

  it("accepts a normally-signed HS256 token (no behavior regression)", async () => {
    const token = jwt.sign(
      { sub: reviewerId, email: reviewerEmail, role: "admin", tokenVersion: 0 },
      config.jwtSecret,
      { expiresIn: "1h", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(reviewerEmail);
  });

  it("rejects a token signed with HS384 under the same secret (401 invalid_token)", async () => {
    const token = jwt.sign(
      { sub: reviewerId, email: reviewerEmail, role: "admin", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS384", expiresIn: "1h", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
  });

  it("rejects a token signed with HS512 under the same secret (401 invalid_token)", async () => {
    const token = jwt.sign(
      { sub: reviewerId, email: reviewerEmail, role: "admin", tokenVersion: 0 },
      config.jwtSecret,
      { algorithm: "HS512", expiresIn: "1h", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
    );
    const res = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
  });
});
