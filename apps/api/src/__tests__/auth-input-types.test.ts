/**
 * Malformed-TYPE inputs on auth surfaces must be rejected with the same 400
 * the missing-field path produces — never reach bcrypt/drizzle/.trim() and
 * surface as a 500 (or leak a different error family than a missing field).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";

describe("Auth surfaces reject malformed input types", () => {
  let app: any;
  let client: any;
  let user: { reviewer: any; sessionToken: string };

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    const db = testDb.db;
    await seedTestProject(db);
    app = createApp({ db });
    user = await seedReviewer(db, app, { email: "types@test.com", role: "reviewer" });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("login: object email is a 400 missing_credentials, not a DB probe", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: { $gt: "" }, password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_credentials");
  });

  it("login: numeric password is a 400 missing_credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "types@test.com", password: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_credentials");
  });

  it("2fa/validate: non-string ticket and code are a 400 missing_fields", async () => {
    const res = await request(app)
      .post("/api/v1/auth/2fa/validate")
      .send({ login_ticket: {}, code: 123456 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_fields");
  });

  it("2fa disable: object current_password is a 400 missing_password, not a 500", async () => {
    const res = await request(app)
      .delete("/api/v1/auth/2fa")
      .set("Authorization", `Bearer ${user.sessionToken}`)
      .send({ current_password: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_password");
  });

  it("2fa backup-codes: object current_password is a 400 missing_password, not a 500", async () => {
    const res = await request(app)
      .post("/api/v1/auth/2fa/backup-codes")
      .set("Authorization", `Bearer ${user.sessionToken}`)
      .send({ current_password: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_password");
  });

  it("invite accept: array name is a 400 missing_required_fields, not a token probe", async () => {
    const res = await request(app)
      .post("/api/v1/auth/invite/some-token")
      .send({ name: [], password: "SecurePassword123!" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("missing_required_fields");
  });

  it("profile: object current_password on password change is a 400, not a 500", async () => {
    const res = await request(app)
      .put("/api/v1/auth/profile")
      .set("Authorization", `Bearer ${user.sessionToken}`)
      .send({ new_password: "NewSecurePassword123!", current_password: {} });
    expect(res.status).toBe(400);
    // Must be the missing/malformed-field rejection, not "incorrect_password"
    // from feeding the object into verifyPassword.
    expect(res.body.error.code).toBe("missing_current_password");
  });
});
