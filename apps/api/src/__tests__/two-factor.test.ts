import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as OTPAuth from "otpauth";
import type { Express } from "express";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { createApp } from "../app";

describe("Two-factor authentication", () => {
  let db: any;
  let client: any;
  let app: Express;
  let sessionToken: string;
  let totpSecret: string;
  let backupCodes: string[];

  beforeAll(async () => {
    process.env.TOTP_ENCRYPTION_KEY = "a".repeat(64);
    const testDb = await createTestDb();
    db = testDb.db;
    client = testDb.client;
    await seedTestProject(db);
    app = createApp({ db });
    const seed = await seedReviewer(db, app, { email: "totp@test.com", role: "admin" });
    sessionToken = seed.sessionToken;
  });

  afterAll(async () => {
    delete process.env.TOTP_ENCRYPTION_KEY;
    await client?.close();
  });

  describe("Setup flow", () => {
    it("POST /2fa/setup returns QR code and secret", async () => {
      const res = await request(app)
        .post("/api/v1/auth/2fa/setup")
        .set("Authorization", `Bearer ${sessionToken}`);
      expect(res.status).toBe(200);
      expect(res.body.base32).toBeTruthy();
      expect(res.body.qr_data_url).toContain("data:image/png");
      expect(res.body.uri).toContain("otpauth://totp/");
      totpSecret = res.body.base32;
    });

    it("POST /2fa/verify-setup with correct code enables 2FA", async () => {
      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(totpSecret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const code = totp.generate();

      const res = await request(app)
        .post("/api/v1/auth/2fa/verify-setup")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ code });
      expect(res.status).toBe(200);
      expect(res.body.backup_codes).toHaveLength(10);
      backupCodes = res.body.backup_codes;
    });

    it("POST /2fa/verify-setup with wrong code fails", async () => {
      const seed = await seedReviewer(db, app, { email: "totp-fail@test.com", role: "admin" });
      await request(app)
        .post("/api/v1/auth/2fa/setup")
        .set("Authorization", `Bearer ${seed.sessionToken}`);

      const res = await request(app)
        .post("/api/v1/auth/2fa/verify-setup")
        .set("Authorization", `Bearer ${seed.sessionToken}`)
        .send({ code: "000000" });
      expect(res.status).toBe(400);
    });
  });

  describe("Login with 2FA", () => {
    it("login returns requires_2fa when 2FA enabled", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });
      expect(res.status).toBe(200);
      expect(res.body.requires_2fa).toBe(true);
      expect(res.body.login_ticket).toBeTruthy();
    });

    it("POST /2fa/validate with correct TOTP completes login", async () => {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });

      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(totpSecret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const code = totp.generate();

      const res = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: loginRes.body.login_ticket, code });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.reviewer.email).toBe("totp@test.com");
    });

    it("POST /2fa/validate with backup code completes login", async () => {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });

      const res = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: loginRes.body.login_ticket, code: backupCodes[0] });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    });

    it("POST /2fa/validate with used backup code fails", async () => {
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });

      const res = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: loginRes.body.login_ticket, code: backupCodes[0] });
      expect(res.status).toBe(401);
    });

    it("POST /2fa/validate with invalid ticket fails", async () => {
      const res = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: "invalid", code: "123456" });
      expect(res.status).toBe(401);
    });
  });

  // Ordered before "Disable 2FA" on purpose: that block turns 2FA off, and this
  // route refuses to run without it.
  describe("Regenerate backup codes", () => {
    it("POST /2fa/backup-codes requires current password", async () => {
      const res = await request(app)
        .post("/api/v1/auth/2fa/backup-codes")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    // Same gap the DELETE /2fa suite had: an empty body stops at the
    // missing-field guard and never reaches the password *check*.
    // Deleting `if (!passwordValid) throw` in routes/two-factor.ts left this
    // route entirely green before this test existed, which matters more here
    // than on disable — regenerating silently invalidates every code the owner
    // is holding, so an unauthenticated caller could lock them out of their own
    // account without ever knowing the password.
    it("POST /2fa/backup-codes rejects a wrong current password", async () => {
      const res = await request(app)
        .post("/api/v1/auth/2fa/backup-codes")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ current_password: "not-the-right-password" });
      expect(res.status).toBe(401);
      expect(res.body.backup_codes).toBeUndefined();
    });

    it("POST /2fa/backup-codes issues a fresh set and retires the old ones", async () => {
      const stale = backupCodes[1]; // unused: only backupCodes[0] has been spent
      const res = await request(app)
        .post("/api/v1/auth/2fa/backup-codes")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ current_password: "password123" });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.backup_codes)).toBe(true);
      expect(res.body.backup_codes.length).toBeGreaterThan(0);
      expect(res.body.backup_codes).not.toContain(stale);

      // A code from the retired set must no longer authenticate. Without this,
      // a regenerate that appended instead of replacing would pass.
      const staleLogin = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });
      const staleRes = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: staleLogin.body.login_ticket, code: stale });
      expect(staleRes.status).toBe(401);

      // and one from the new set must work
      const freshLogin = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });
      const freshRes = await request(app)
        .post("/api/v1/auth/2fa/validate")
        .send({ login_ticket: freshLogin.body.login_ticket, code: res.body.backup_codes[0] });
      expect(freshRes.status).toBe(200);
      expect(freshRes.body.token).toBeTruthy();
    });
  });

  describe("Disable 2FA", () => {
    it("DELETE /2fa requires current password", async () => {
      const res = await request(app)
        .delete("/api/v1/auth/2fa")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    // The test above sends an empty body, so it only reaches the
    // missing-field guard and never exercises the password *check*.
    // Mutation-tested: deleting the `if (!passwordValid) throw` in
    // routes/two-factor.ts left the whole suite green, because no test
    // anywhere sent a wrong password to this route. This one does.
    it("DELETE /2fa rejects a wrong current password", async () => {
      const res = await request(app)
        .delete("/api/v1/auth/2fa")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ current_password: "not-the-right-password" });
      expect(res.status).toBe(401);

      // and 2FA must still be enabled afterwards
      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });
      expect(loginRes.body.requires_2fa).toBe(true);
    });

    it("DELETE /2fa with correct password disables 2FA", async () => {
      const res = await request(app)
        .delete("/api/v1/auth/2fa")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ current_password: "password123" });
      expect(res.status).toBe(200);

      const loginRes = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "totp@test.com", password: "password123" });
      expect(loginRes.body.requires_2fa).toBeFalsy();
      expect(loginRes.body.token).toBeTruthy();
    });
  });
});
