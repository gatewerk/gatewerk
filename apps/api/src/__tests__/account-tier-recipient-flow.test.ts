import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { stampAccountTierDecided } from "../routes/token-reviews-account-tier";
import { createAuditService } from "../services/audit";
import {
  reviewTokens,
  reviews,
  templates,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_COOKIE_NAME,
  recipientSessionCookieName,
} from "../services/token-recipient-session";

/**
 * Account-bound recipient flow (token redesign §6.2 + edge case E15).
 * Mirrors the email-otp-recipient-flow.test.ts shape: direct DB token
 * insert (sidesteps the tokens-route gate which still blocks
 * auth_level: "account" creation) + supertest exercises the consumer
 * surface. Locks the contract that GET /r/:token and POST /decide both
 * gate on a main-app Bearer JWT for account-tier tokens, and that
 * /auth/login validates the optional return_to allowlist.
 */

describe("account-bound recipient flow", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;
  let aliceId: string;
  let aliceToken: string;
  let bobId: string;
  let bobToken: string;

  async function makeAccountToken(
    authUserId: string,
  ): Promise<{ tokenId: string; rawToken: string; reviewId: string }> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_id: templateId,
        template_slug: templateSlug,
        payload: { subject: "test" },
        status: "awaiting_external",
      })
      .returning();
    const tokenId = generateId("token");
    // Same construction as email-otp-recipient-flow.test.ts: the route-layer
    // create-token gate at apps/api/src/routes/reviews/tokens.ts blocks
    // auth_level: "account" creation until the editor UI lands. Direct
    // DB insert exercises the consumer surface that is the subject of
    // this iteration.
    const rawToken = `gw_tok_${tokenId.slice(7)}_test`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(reviewTokens).values({
      id: tokenId,
      token_hash: tokenHash,
      review_id: rev.id,
      project_id: projectId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      purpose: "test",
      recipient_label: "test recipient",
      auth_level: "account",
      auth_user_id: authUserId,
      created_by_kind: "manual",
      created_by_id: "test",
    });
    return { tokenId, rawToken, reviewId: rev.id };
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    const [tpl] = await db
      .insert(templates)
      .values({
        id: generateId("template"),
        slug: "account-flow-test",
        project_id: projectId,
        name: "Account Flow Test",
        fields: [{ name: "subject", type: "text", label: "Subject" }],
        actions: ["approve", "reject"],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db });

    const aliceSeed = await seedReviewer(db, app, {
      email: "alice@account-test.local",
      name: "Alice",
    });
    aliceId = aliceSeed.reviewer.id;
    aliceToken = aliceSeed.sessionToken;

    const bobSeed = await seedReviewer(db, app, {
      email: "bob@account-test.local",
      name: "Bob",
    });
    bobId = bobSeed.reviewer.id;
    bobToken = bobSeed.sessionToken;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // ---- GET /r/:token (account-tier) ----------------------------------------

  describe("GET /r/:token (auth_level: account)", () => {
    it("AC1: no Authorization header → 200 requires_account_login + audit", async () => {
      const { rawToken, reviewId } = await makeAccountToken(aliceId);
      const res = await request(app).get(`/r/${rawToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.requires_account_login).toBe(true);
      expect(res.body.review).toBeUndefined();
      expect(res.body.template).toBeUndefined();
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const redirect = audits.find(
        (a: any) => a.action === "token.account_login_redirect",
      );
      expect(redirect).toBeTruthy();
      // Iter 2.1 S3 forensic-anchor contract — every account-tier audit
      // must carry ip_address in details.
      expect(redirect.details.ip_address).toBeDefined();
    });

    it("AC2: matching Authorization → 200 with full review + template", async () => {
      const { rawToken } = await makeAccountToken(aliceId);
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Authorization", `Bearer ${aliceToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.requires_account_login).toBeUndefined();
      expect(res.body.account_mismatch).toBeUndefined();
      expect(res.body.review).toBeDefined();
      expect(res.body.review.payload).toEqual({ subject: "test" });
      expect(res.body.template).toBeDefined();
      expect(res.body.template.name).toBe("Account Flow Test");
    });

    it("AC3: Authorization for different user → 200 account_mismatch + audit", async () => {
      const { rawToken, reviewId } = await makeAccountToken(aliceId);
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Authorization", `Bearer ${bobToken}`);
      expect(res.status).toBe(200);
      expect(res.body.account_mismatch).toBe(true);
      expect(res.body.current_account_label).toBe("bob@account-test.local");
      // Recipient PII protection — expected_account_label intentionally
      // omitted server-side. Audit captures expected_user_id for ops.
      expect(res.body.expected_account_label).toBeUndefined();
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const mismatch = audits.find(
        (a: any) => a.action === "token.account_mismatch",
      );
      expect(mismatch).toBeTruthy();
      expect(mismatch.details.expected_user_id).toBe(aliceId);
      expect(mismatch.details.actual_user_id).toBe(bobId);
      expect(mismatch.details.ip_address).toBeDefined();
    });

    it("AC4: invalid Authorization → 200 requires_account_login (treated as not logged in)", async () => {
      const { rawToken } = await makeAccountToken(aliceId);
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Authorization", "Bearer not.a.valid.jwt");
      expect(res.status).toBe(200);
      expect(res.body.requires_account_login).toBe(true);
      expect(res.body.account_mismatch).toBeUndefined();
    });

    it("AC5: recipient-session JWT replayed in Authorization → 200 requires_account_login (audience-claim isolation)", async () => {
      // RFC 7519 §4.1.3 audience isolation. validateJwt rejects any token
      // carrying aud:"token-recipient" so a recipient-session cookie value
      // forwarded into Authorization cannot impersonate a main-app session.
      // This is the cookie-transport-asymmetry defense locked from Iter 2.1.
      const { rawToken } = await makeAccountToken(aliceId);
      const recipientJwt = jwt.sign(
        { sub: "tok_anything" },
        config.jwtSecret,
        {
          expiresIn: "30m",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
        },
      );
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Authorization", `Bearer ${recipientJwt}`);
      expect(res.status).toBe(200);
      expect(res.body.requires_account_login).toBe(true);
    });

    it("AC4b: expired Authorization → 200 requires_account_login (TokenExpiredError path)", async () => {
      // AC4 covers JsonWebTokenError (malformed). This case independently
      // pins the TokenExpiredError catch path so a refactor that narrows
      // the catch surface cannot silently flip an expired-token request
      // into a 500.
      const expired = jwt.sign(
        { sub: aliceId, email: "alice@account-test.local", role: "reviewer" },
        config.jwtSecret,
        { expiresIn: "-1s" },
      );
      const { rawToken } = await makeAccountToken(aliceId);
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Authorization", `Bearer ${expired}`);
      expect(res.status).toBe(200);
      expect(res.body.requires_account_login).toBe(true);
    });

    it("AC6: account-tier token + recipient cookie + wrong-user Bearer → uses Bearer identity (cookie ignored)", async () => {
      // Pins the auth_level discriminator branch ordering against future
      // reorder. account-tier reads Authorization; the recipient cookie
      // is only consulted on email_otp tokens. Cookie set here MUST NOT
      // override the Bearer-derived identity check.
      const { rawToken, tokenId } = await makeAccountToken(aliceId);
      const recipientJwt = jwt.sign(
        { sub: "tok_anything", email: "phisher@x.com" },
        config.jwtSecret,
        {
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          expiresIn: "30m",
        },
      );
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${recipientJwt}`)
        .set("Authorization", `Bearer ${bobToken}`);
      expect(res.body.account_mismatch).toBe(true);
      expect(res.body.current_account_label).toBe("bob@account-test.local");
    });
  });

  // ---- POST /r/:token/decide (account-tier) --------------------------------

  describe("POST /r/:token/decide (auth_level: account)", () => {
    it("AD1: matching Bearer → 200, decided_by_user_id populated, audit account_decided", async () => {
      const { tokenId, rawToken, reviewId } = await makeAccountToken(aliceId);
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("decided");
      expect(res.body.decision).toBe("approved");
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.decided_by_user_id).toBe(aliceId);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const decided = audits.find(
        (a: any) => a.action === "token.account_decided",
      );
      expect(decided).toBeTruthy();
      expect(decided.details.decided_by_user_id).toBe(aliceId);
      expect(decided.details.decided_by_email).toBe("alice@account-test.local");
      expect(decided.details.ip_address).toBeDefined();
      // Happy path: stamp succeeded, so the audit must NOT carry the
      // forensic-failure discriminator.
      expect(decided.details.stamp_failed).toBeUndefined();
    });

    it("AD2: Bearer for different user → 401 account_mismatch + audit (no token consume)", async () => {
      const { tokenId, rawToken, reviewId } = await makeAccountToken(aliceId);
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Authorization", `Bearer ${bobToken}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("account_mismatch");
      // Token MUST NOT be consumed by a wrong-identity decide.
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.used_at).toBeNull();
      expect(tokenRow.decided_by_user_id).toBeNull();
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const mismatch = audits.find(
        (a: any) =>
          a.action === "token.account_mismatch" &&
          a.details?.phase === "decide",
      );
      expect(mismatch).toBeTruthy();
    });

    it("AD3: no Authorization → 401 account_login_required (no token consume)", async () => {
      const { tokenId, rawToken } = await makeAccountToken(aliceId);
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .send({ decision: "approved" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("account_login_required");
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.used_at).toBeNull();
    });

    it("AD4: stamp UPDATE failure does not block decision; audit fires with stamp_failed:true", async () => {
      // Forensic-completeness contract — if the decided_by_user_id stamp
      // UPDATE rejects, the audit emit MUST surface the failure with a
      // stamp_failed:true discriminator instead of unconditionally
      // claiming reconstruction. Exercises the helper directly with a
      // fake db whose update().set().where() chain rejects.
      const { tokenId, reviewId } = await makeAccountToken(aliceId);
      const audit = createAuditService(db);
      const fakeDb = {
        update: () => ({
          set: () => ({
            where: () =>
              Promise.reject(new Error("simulated stamp constraint reject")),
          }),
        }),
      } as any;
      const fakeReq = { ip: "127.0.0.1" } as any;
      const session = {
        id: aliceId,
        email: "alice@account-test.local",
        name: "Alice",
        role: "reviewer",
      };
      await stampAccountTierDecided(
        fakeReq,
        fakeDb,
        tokenId,
        reviewId,
        projectId,
        session,
        audit,
      );
      // Allow the fire-and-forget audit emit to flush.
      await new Promise((r) => setTimeout(r, 20));
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const decided = audits.find(
        (a: any) =>
          a.action === "token.account_decided" &&
          a.details?.stamp_failed === true,
      );
      expect(decided).toBeTruthy();
      expect(decided.details.error_message).toMatch(/simulated stamp constraint reject/);
      expect(decided.details.decided_by_user_id).toBe(aliceId);
      expect(decided.details.decided_by_email).toBe("alice@account-test.local");
      expect(decided.details.ip_address).toBe("127.0.0.1");
    });

    it("AD5: recipient-session JWT replayed in Authorization on /decide → 401 (audience-claim isolation)", async () => {
      // Mirrors AC5 for the verb that matters most — decide is irreversible.
      // Audience isolation (RFC 7519 §4.1.3) MUST reject a recipient-cookie
      // value forwarded into Authorization so it cannot consume the token.
      const { tokenId, rawToken } = await makeAccountToken(aliceId);
      const recipientJwt = jwt.sign(
        { sub: "tok_anything", email: "phisher@x.com" },
        config.jwtSecret,
        {
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          expiresIn: "30m",
        },
      );
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Authorization", `Bearer ${recipientJwt}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("account_login_required");
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.used_at).toBeNull();
    });
  });

  // ---- POST /auth/login return_to validation -------------------------------

  describe("POST /auth/login return_to allowlist", () => {
    it("LR1: return_to=/r/abc → 200 + return_to echoed", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/r/abc",
        });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.return_to).toBe("/r/abc");
    });

    // LR1b–LR1e: the second allowed target. The "your turn" email links to
    // /reviews/<id> — without this, a signed-out reviewer who taps it loses
    // the review at the login screen and lands in the inbox instead.
    it("LR1b: return_to=/reviews/<id> → 200 + return_to echoed", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/reviews/gw_rev_95ppKbjUMzCXarsX1bXSdJBY",
        });
      expect(res.status).toBe(200);
      expect(res.body.return_to).toBe("/reviews/gw_rev_95ppKbjUMzCXarsX1bXSdJBY");
    });

    it("LR1c: return_to=/reviews/abc/../../settings → 400 (cannot walk out)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/reviews/abc/../../settings",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR1d: return_to=/reviewsomething/abc → 400 (lookalike prefix)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/reviewsomething/abc",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR1e: return_to=https://evil.example.com/reviews/abc → 400 (absolute URL)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "https://evil.example.com/reviews/abc",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR2: return_to=/inbox → 400 invalid_return_to (not /r/ prefix)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/inbox",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR3: return_to=//evil.com → 400 invalid_return_to (protocol-relative)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "//evil.com",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR4: return_to=/r/../inbox → 400 invalid_return_to (path traversal)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "/r/../inbox",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR5: return_to=javascript:alert(1) → 400 invalid_return_to (URI scheme)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: "javascript:alert(1)",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });

    it("LR6: no return_to → 200 with no return_to in response (legacy /login behavior preserved)", async () => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
        });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.return_to).toBeUndefined();
    });

    // LR-extended deny coverage — RFC 3986 §3.1 (URI scheme syntax) +
    // §4.2 (relative-reference). Pins each deny branch independently so
    // a refactor that broadens validateReturnTo cannot silently allow a
    // new scheme or path-shape.
    it.each([
      ["data:image/png;base64,AAA", "data scheme"],
      ["vbscript:msgbox(1)", "vbscript scheme"],
      ["file:///etc/passwd", "file scheme"],
      ["myapp://callback", "custom scheme"],
      ["/r/path\\to\\file", "backslash in path"],
      ["", "empty string"],
    ])("LR-extended: return_to=%s → 400 invalid_return_to (%s)", async (rt) => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({
          email: "alice@account-test.local",
          password: "password123",
          return_to: rt,
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_return_to");
    });
  });
});
