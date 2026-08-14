import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, and, desc } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import type { EmailTransport } from "../services/email/transport";

describe("Settings → Email (status + test)", () => {
  let app: any;
  let client: any;
  let db: any;
  let adminToken: string;
  let adminUserId: string;
  let reviewerToken: string;
  const stubSend = vi.fn();
  const stubClose = vi.fn().mockResolvedValue(undefined);
  const stubTransport: EmailTransport = {
    send: (input) => stubSend(input),
    close: () => stubClose(),
  };

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    await seedTestProject(db);

    adminUserId = generateId("user");
    await db.insert(reviewers).values({
      id: adminUserId,
      email: "admin@test-emset.local",
      name: "Test Admin Email",
      password_hash: await bcrypt.hash("admin123", 10),
      role: "admin",
    });
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: "reviewer@test-emset.local",
      name: "Test Reviewer Email",
      password_hash: await bcrypt.hash("reviewer123", 10),
      role: "reviewer",
    });

    app = createApp({ db, emailTransport: stubTransport });

    adminToken = (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "admin@test-emset.local", password: "admin123" })
    ).body.token;
    reviewerToken = (
      await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "reviewer@test-emset.local", password: "reviewer123" })
    ).body.token;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  beforeEach(() => {
    // Each test resets the shared stub. The route-level rate-limit Map is also
    // shared across tests; tests that don't care about it use the admin user
    // and stay under the cap.
    stubSend.mockReset();
  });

  describe("GET /api/v1/settings/email/status", () => {
    it("returns the none variant when injected transport runs without SMTP_* env (predicate-drift degrade)", async () => {
      // Test env doesn't set SMTP_HOST/PORT/FROM. The injected transport
      // makes sendTestEmail callable, but the discriminated-union status
      // schema requires the smtp variant to carry full host/port/from — so
      // the route degrades to "none" with a console.warn rather than emit
      // a structurally-invalid (transport=smtp + smtp:null) response.
      const res = await request(app)
        .get("/api/v1/settings/email/status")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.transport).toBe("none");
      expect(res.body.configured).toBe(false);
      expect(res.body.resend_configured).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/pass|password|api_key|apikey/i);
    });

    it("returns 403 to non-admin reviewer", async () => {
      const res = await request(app)
        .get("/api/v1/settings/email/status")
        .set("Authorization", `Bearer ${reviewerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/v1/settings/email/test", () => {
    it("returns status=sent with message_id on a successful transport.send()", async () => {
      stubSend.mockResolvedValueOnce({ messageId: "<test-msg-123@gatewerk.local>" });

      const res = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "admin@test-emset.local" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("sent");
      expect(res.body.message_id).toBe("<test-msg-123@gatewerk.local>");
      expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
      expect(stubSend).toHaveBeenCalledTimes(1);
      const sentArgs = stubSend.mock.calls[0][0];
      expect(sentArgs.to).toBe("admin@test-emset.local");
      expect(sentArgs.subject).toContain("Gatewerk");
      // Hygiene headers (List-Unsubscribe, Auto-Submitted) preserved on the
      // test path so admins debugging deliverability see the same envelope as
      // production sends.
      expect(sentArgs.headers["Auto-Submitted"]).toBe("auto-generated");
      expect(sentArgs.headers["List-Unsubscribe"]).toBeTruthy();
    });

    it("returns status=failed with the underlying error message on transport rejection", async () => {
      stubSend.mockRejectedValueOnce(new Error("EAUTH: Invalid SMTP credentials"));

      const res = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "admin@test-emset.local" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.error).toContain("EAUTH");
      // Service contract is "NEVER throws" — failed branch must still respond 200.
    });

    it("rejects CRLF in the to address (header injection guard)", async () => {
      stubSend.mockClear();
      const res = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        // Zod email validation rejects this at the boundary — assert the
        // outer layer catches it without ever reaching transport.send().
        .send({ to: "admin@test-emset.local\r\nBcc: attacker@evil.com" });

      // Either the Zod email schema rejects with 422 OR (if ever loosened)
      // the service-layer CRLF guard returns status=failed with
      // header_injection_detected. Both are acceptable defenses.
      if (res.status === 422) {
        expect(res.body.error.code).toBe("validation_failed");
      } else {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("failed");
        expect(res.body.error).toBe("header_injection_detected");
      }
      expect(stubSend).not.toHaveBeenCalled();
    });

    it("returns 422 when to is missing or invalid", async () => {
      const missing = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({});
      expect(missing.status).toBe(422);

      const invalid = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "not-an-email" });
      expect(invalid.status).toBe(422);
    });

    it("returns 403 to non-admin reviewer", async () => {
      const res = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${reviewerToken}`)
        .send({ to: "reviewer@test-emset.local" });
      expect(res.status).toBe(403);
      expect(stubSend).not.toHaveBeenCalled();
    });

    it("bypasses service-level rate-limit and idempotency — 3 sends in a row all succeed", async () => {
      stubSend.mockResolvedValue({ messageId: "<repeat@gatewerk.local>" });

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post("/api/v1/settings/email/test")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ to: "admin@test-emset.local" });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("sent");
      }
      expect(stubSend).toHaveBeenCalledTimes(3);
    });

    it("emits a route-level audit row with the admin reviewer id on each test send", async () => {
      stubSend.mockResolvedValueOnce({ messageId: "<audit-row-1@gatewerk.local>" });
      const res = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "admin@test-emset.local" });
      expect(res.status).toBe(200);

      // Allow the awaited route emit a microtask to flush.
      await new Promise((r) => setTimeout(r, 30));

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "email.test_sent"), eq(auditLog.actor, adminUserId)))
        .orderBy(desc(auditLog.created_at))
        .limit(1);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const details = rows[0].details as Record<string, unknown>;
      expect(details.to).toBe("admin@test-emset.local");
      expect(details.status).toBe("sent");
      expect(details.message_id).toBe("<audit-row-1@gatewerk.local>");
      expect(typeof details.latency_ms).toBe("number");
    });

    it("emits email.test_failed audit row with the admin id when transport rejects", async () => {
      stubSend.mockRejectedValueOnce(new Error("EAUTH: bad creds"));
      await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "admin@test-emset.local" });

      await new Promise((r) => setTimeout(r, 30));

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "email.test_failed"), eq(auditLog.actor, adminUserId)))
        .orderBy(desc(auditLog.created_at))
        .limit(1);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const details = rows[0].details as Record<string, unknown>;
      expect(details.error).toContain("EAUTH");
    });
  });

  describe("POST /api/v1/settings/email/test — route-level rate limit", () => {
    let burstAdminToken: string;
    let burstAdminId: string;

    beforeAll(async () => {
      burstAdminId = generateId("user");
      await db.insert(reviewers).values({
        id: burstAdminId,
        email: "burst@test-emset.local",
        name: "Burst Admin",
        password_hash: await bcrypt.hash("burst123", 10),
        role: "admin",
      });
      burstAdminToken = (
        await request(app)
          .post("/api/v1/auth/login")
          .send({ email: "burst@test-emset.local", password: "burst123" })
      ).body.token;
    });

    it("returns 429 with structured failed response after 10 sends in 60s", async () => {
      stubSend.mockResolvedValue({ messageId: "<burst@gatewerk.local>" });

      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post("/api/v1/settings/email/test")
          .set("Authorization", `Bearer ${burstAdminToken}`)
          .send({ to: "burst@test-emset.local" });
        expect(res.status).toBe(200);
      }
      // 11th call — over the cap
      const tripped = await request(app)
        .post("/api/v1/settings/email/test")
        .set("Authorization", `Bearer ${burstAdminToken}`)
        .send({ to: "burst@test-emset.local" });
      expect(tripped.status).toBe(429);
      expect(tripped.body.status).toBe("failed");
      expect(tripped.body.error).toMatch(/rate_limited/);
      expect(tripped.body.latency_ms).toBe(0);
    });
  });
});
