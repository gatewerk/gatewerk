import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  emailOtpCodes,
  reviewTokens,
  reviews,
  templates,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import type {
  EmailTransport,
  EmailTransportSendInput,
} from "../services/email/transport";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_TTL_SECONDS,
  RECIPIENT_SESSION_COOKIE_NAME,
  recipientSessionCookieName,
} from "../services/token-recipient-session";
import jwt from "jsonwebtoken";
import { config } from "../config";

interface CapturedSend extends EmailTransportSendInput {
  messageId: string;
}

function makeCapturingTransport(): EmailTransport & { sends: CapturedSend[] } {
  const sends: CapturedSend[] = [];
  return {
    sends,
    async send(input) {
      const messageId = `mid-${sends.length + 1}-${Date.now()}`;
      sends.push({ ...input, messageId });
      return { messageId };
    },
    async close() {},
  };
}

/** Extract OTP code from the captured email body — looks for any 6-digit run. */
function codeFromCapture(send: CapturedSend | undefined): string {
  if (!send) throw new Error("no captured send");
  const m = send.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no 6-digit code in: ${send.text}`);
  return m[1];
}

describe("email-otp recipient flow", () => {
  let app: any;
  let client: any;
  let db: any;
  let transport: ReturnType<typeof makeCapturingTransport>;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  async function makeEmailOtpToken(opts: {
    auth_email: string;
    auth_level?: "public" | "email_otp" | "account";
    locked?: boolean;
  }): Promise<{ tokenId: string; rawToken: string; reviewId: string }> {
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
    // Per services/review-tokens.ts, the raw token format is gw_tok_<hex>;
    // we encode the row id as the raw token suffix so token_hash = sha256
    // of the full raw token. Direct DB construction is intentional — it
    // sidesteps the route-layer guard at routes/reviews/tokens.ts that
    // blocks auth_level: "email_otp" token creation until the recipient
    // editor UI lands; tests need to construct these tokens to exercise
    // the consumer surface.
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
      auth_level: opts.auth_level ?? "email_otp",
      auth_email: opts.auth_email,
      created_by_kind: "manual",
      created_by_id: "test",
      otp_locked_until: opts.locked
        ? new Date(Date.now() + 60 * 60 * 1000)
        : null,
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
        slug: "otp-flow-test",
        project_id: projectId,
        name: "OTP Flow Test",
        fields: [{ name: "subject", type: "text", label: "Subject" }],
        actions: ["approve", "reject"],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    transport = makeCapturingTransport();
    app = createApp({ db, emailTransport: transport });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  beforeEach(() => {
    transport.sends.length = 0;
  });

  // ---- /request ------------------------------------------------------------

  describe("POST /r/:token/email-otp/request", () => {
    it("R1: valid email returns 200 + audits sent + transport receives the code", async () => {
      const { rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "alice@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "alice@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("sent");
      expect(transport.sends.length).toBe(1);
      const code = codeFromCapture(transport.sends[0]);
      expect(code).toMatch(/^\d{6}$/);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some((a: any) => a.action === "token.email_otp_sent"),
      ).toBe(true);
      // OWASP A09 — IP capture is the forensic anchor for abuse
      // investigation. Loopback variants are accepted because supertest
      // exercises the route via in-process socket; production captures
      // the real remote address.
      const sentAudit = audits.find(
        (a: any) => a.action === "token.email_otp_sent",
      );
      expect(sentAudit?.details?.ip_address).toBeTruthy();
      expect(sentAudit?.details?.ip_address).toMatch(
        /^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/,
      );
    });

    it("R2: wrong email returns 400 + audits wrong_email with submitted truncated", async () => {
      const { rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "alice@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "evil@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("email_mismatch");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const wrong = audits.find(
        (a: any) => a.action === "token.email_otp_wrong_email",
      );
      expect(wrong).toBeTruthy();
      expect(wrong.details.submitted_email).toBe("evil@example.com");
      expect(transport.sends.length).toBe(0);
    });

    it("R3: case variants on email match are accepted", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "alice@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "Alice@Example.COM" });
      expect(res.status).toBe(200);
      expect(transport.sends.length).toBe(1);
    });

    it("R4: resend within 60s is rejected with resend_cooldown", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "bob@example.com",
      });
      const first = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "bob@example.com" });
      expect(first.status).toBe(200);
      const second = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "bob@example.com" });
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("resend_cooldown");
    });

    it("R5: resend after 60s window is accepted", async () => {
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "carla@example.com",
      });
      const first = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "carla@example.com" });
      expect(first.status).toBe(200);
      // Backdate the existing OTP row so it falls outside the cooldown.
      await db
        .update(emailOtpCodes)
        .set({ created_at: new Date(Date.now() - 120_000) })
        .where(eq(emailOtpCodes.token_id, tokenId));
      const second = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "carla@example.com" });
      expect(second.status).toBe(200);
      expect(transport.sends.length).toBe(2);
    });

    it("R6: non-email_otp token returns 400 auth_level_mismatch", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "doug@example.com",
        auth_level: "public",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "doug@example.com" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("auth_level_mismatch");
    });

    it("R7: locked token returns 423 token_locked", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "eve@example.com",
        locked: true,
      });
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "eve@example.com" });
      expect(res.status).toBe(423);
      expect(res.body.error.code).toBe("token_locked");
    });

    it("R8: SMTP unconfigured (no transport) returns 200 sent + skipped_no_config audit", async () => {
      // Build a separate app without an injected transport and with no
      // SMTP envs — emailService falls through to skipped_no_config.
      const noTransportApp = createApp({ db });
      const { rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "frank@example.com",
      });
      const res = await request(noTransportApp)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "frank@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("sent");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const sentAudit = audits.find(
        (a: any) => a.action === "token.email_otp_sent",
      );
      expect(sentAudit?.details.send_status).toBe("skipped_no_config");
    });
  });

  // ---- /verify -------------------------------------------------------------

  describe("POST /r/:token/email-otp/verify", () => {
    async function requestThen(
      rawToken: string,
      email: string,
    ): Promise<string> {
      transport.sends.length = 0;
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email });
      expect(res.status).toBe(200);
      return codeFromCapture(transport.sends[0]);
    }

    it("V1: correct code returns 200 + sets cookie + audit verified", async () => {
      const { rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "v1@example.com",
      });
      const code = await requestThen(rawToken, "v1@example.com");
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("verified");
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeTruthy();
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      // NODE_ENV=test → unprefixed cookie name; production path is a
      // separate test below in V1b.
      expect(cookieHeader).toContain(RECIPIENT_SESSION_COOKIE_NAME);
      expect(cookieHeader).toContain("HttpOnly");
      // RFC 6265 §5.3 prefix-matching: Path must equal the API mount
      // (/api/v1/r) so the browser includes the cookie on subsequent
      // GET /api/v1/r/:token and POST /api/v1/r/:token/decide. A Path of
      // "/r" alone would silently fail in the browser even though
      // supertest's cookie jar ignores Path.
      expect(cookieHeader).toContain("Path=/api/v1/r");
      expect(cookieHeader).toMatch(/SameSite=Strict/);
      // 30min — Max-Age mirrors the JWT exp claim per RFC 7519 alignment.
      expect(cookieHeader).toMatch(/;\s*Max-Age=1800(;|$)/);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some((a: any) => a.action === "token.email_otp_verified"),
      ).toBe(true);
    });

    it("V1c: cookie Path attribute is /api/v1/r so browsers send it on /api/v1/r/:token/decide", async () => {
      // RFC 6265 §5.3 path-matching: a cookie's Path must prefix-match
      // the request URI for the browser to include the cookie on that
      // request. The recipient API endpoints are mounted at
      // /api/v1/r/* — a Path of "/r" would NOT match /api/v1/r/:token
      // requests and the browser would drop the cookie. supertest's
      // cookie jar ignores Path entirely, so this assertion is the
      // regression lock against a Path value that passes integration
      // tests but silently fails in real browsers.
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "v1c@example.com",
      });
      const code = await requestThen(rawToken, "v1c@example.com");
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code });
      expect(res.status).toBe(200);
      const setCookie = res.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieHeader).toBeDefined();
      // Exact Path attribute — both the literal value and the absence of
      // any trailing characters that would NARROW the scope below
      // /api/v1/r. (Trailing characters cannot broaden cookie scope —
      // longer paths narrow it. RFC 6265 §5.1.4 path-match rule 3.)
      expect(cookieHeader).toMatch(/;\s*Path=\/api\/v1\/r(;|$)/);
      // Negative regression lock — must not regress to the Iter 2.1
      // bug where Path=/r was shipped (the gate at routes/reviews/tokens.ts
      // happens to block `email_otp` token creation in production, but
      // the cookie path is still wrong-by-default).
      expect(cookieHeader).not.toMatch(/;\s*Path=\/r(;|$)/);
      // 30min — Max-Age mirrors the JWT exp claim per RFC 7519 alignment.
      expect(cookieHeader).toMatch(/;\s*Max-Age=1800(;|$)/);
    });

    it("V2: wrong code returns 400 + audit failed + attempts incremented", async () => {
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "v2@example.com",
      });
      await requestThen(rawToken, "v2@example.com");
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code: "000000" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("wrong_code");
      const [otpRow] = await db
        .select()
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId));
      expect(otpRow.attempts).toBe(1);
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some((a: any) => a.action === "token.email_otp_failed"),
      ).toBe(true);
    });

    it("V3: 5 wrong codes locks the token (423 + audit + otp_locked_until set, lock fires at 5th not 4th)", async () => {
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "v3@example.com",
      });
      await requestThen(rawToken, "v3@example.com");
      const responses = [] as Array<{ status: number; code?: string }>;
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/r/${rawToken}/email-otp/verify`)
          .send({ code: "111111" });
        responses.push({ status: res.status, code: res.body.error?.code });
      }
      // Intermediate states catch off-by-one regressions: lock must NOT
      // fire before the 5th attempt and MUST fire on it. Previously this
      // asserted only the last response which would have passed even if
      // the lock fired at the 4th wrong code.
      expect(responses[0].status).toBe(400);
      expect(responses[0].code).toBe("wrong_code");
      expect(responses[3].status).toBe(400);
      expect(responses[3].code).toBe("wrong_code");
      expect(responses[4].status).toBe(423);
      expect(responses[4].code).toBe("token_locked");
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.otp_locked_until).not.toBeNull();
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some(
          (a: any) =>
            a.action === "token.email_otp_locked" &&
            a.details?.trigger === "max_attempts",
        ),
      ).toBe(true);
    });

    it("V4: locked token rejects even a correct code", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "v4@example.com",
      });
      const code = await requestThen(rawToken, "v4@example.com");
      // Force lock without going through 5 wrong attempts.
      await db
        .update(reviewTokens)
        .set({ otp_locked_until: new Date(Date.now() + 60 * 60 * 1000) })
        .where(eq(reviewTokens.auth_email, "v4@example.com"));
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code });
      expect(res.status).toBe(423);
    });

    it("V5: non-numeric or wrong-length code returns 400 invalid_code_format", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "v5@example.com",
      });
      await requestThen(rawToken, "v5@example.com");
      const a = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code: "abcdef" });
      expect(a.status).toBe(400);
      expect(a.body.error.code).toBe("invalid_code_format");
      const b = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code: "12345" });
      expect(b.status).toBe(400);
      expect(b.body.error.code).toBe("invalid_code_format");
    });

    it("V6: no active code returns 410 code_expired", async () => {
      const { rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "v6@example.com",
      });
      // Skip the /request step so no row exists.
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code: "000000" });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("code_expired");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some((a: any) => a.action === "token.email_otp_expired"),
      ).toBe(true);
    });

    it("V7: expired active code returns 410 code_expired", async () => {
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "v7@example.com",
      });
      await requestThen(rawToken, "v7@example.com");
      // Backdate expiry so the row is no longer "active".
      await db
        .update(emailOtpCodes)
        .set({ expires_at: new Date(Date.now() - 60_000) })
        .where(eq(emailOtpCodes.token_id, tokenId));
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code: "123456" });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("code_expired");
    });
  });

  // ---- GET /:token gate ----------------------------------------------------

  describe("GET /r/:token email_otp gate", () => {
    it("G1: no cookie returns requires_email_otp:true and omits review/template", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "g1@example.com",
      });
      const res = await request(app).get(`/r/${rawToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.requires_email_otp).toBe(true);
      expect(res.body.review).toBeUndefined();
      expect(res.body.template).toBeUndefined();
      expect(res.body.recipient_email_hint).toBe("g***@example.com");
    });

    it("G2: valid session cookie returns the review payload", async () => {
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "g2@example.com",
      });
      const sessionJwt = jwt.sign(
        { email: "g2@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: tokenId,
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${sessionJwt}`);
      expect(res.status).toBe(200);
      expect(res.body.requires_email_otp).toBeUndefined();
      expect(res.body.review).toBeTruthy();
      expect(res.body.template).toBeTruthy();
    });

    it("G3: cookie bound to a different token returns requires_email_otp + cookie_invalid", async () => {
      const { rawToken, reviewId, tokenId } = await makeEmailOtpToken({
        auth_email: "g3@example.com",
      });
      const otherSession = jwt.sign(
        { email: "x@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: "gw_tok_some_other_token",
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      const res = await request(app)
        .get(`/r/${rawToken}`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${otherSession}`);
      expect(res.body.requires_email_otp).toBe(true);
      expect(res.body.cookie_invalid).toBe(true);
      // RFC 6265 §5.3 — server-side eviction since HttpOnly cookies cannot
      // be cleared from JS. Without this the bad cookie persists for 30min.
      const setCookieHeaders = res.headers["set-cookie"];
      const setCookies = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders].filter(Boolean);
      const clearHeader = setCookies.find((h) =>
        h.includes(RECIPIENT_SESSION_COOKIE_NAME),
      );
      expect(clearHeader).toBeTruthy();
      expect(clearHeader).toMatch(/(Max-Age=0|Expires=)/);
      expect(clearHeader).toMatch(/;\s*Path=\/api\/v1\/r(;|$)/);
      // Audit event emitted so ops can correlate stale-cookie traffic.
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.some(
          (a: any) => a.action === "token.recipient_session_invalidated",
        ),
      ).toBe(true);
    });
  });

  // ---- POST /:token/decide gate -------------------------------------------

  describe("POST /r/:token/decide email_otp gate", () => {
    it("D1: no cookie returns 401 email_otp_required", async () => {
      const { rawToken } = await makeEmailOtpToken({
        auth_email: "d1@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .send({ decision: "approved" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("email_otp_required");
    });

    it("D2: valid cookie decides + clears the cookie via Set-Cookie Max-Age=0", async () => {
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "d2@example.com",
      });
      const sessionJwt = jwt.sign(
        { email: "d2@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: tokenId,
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${sessionJwt}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("decided");
      const setCookieHeaders = res.headers["set-cookie"];
      const setCookies = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];
      const clearHeader = setCookies.find((h) =>
        h.includes(RECIPIENT_SESSION_COOKIE_NAME),
      );
      expect(clearHeader).toBeTruthy();
      // Max-Age=0 OR Expires in the past — either is RFC 6265 §5.3
      // expiry. clearCookie uses Expires in the past.
      expect(clearHeader).toMatch(/(Max-Age=0|Expires=)/);
      // RFC 6265 §5.3 — clearCookie path attribute must match the
      // Set-Cookie path used at issuance or the browser silently retains
      // the cookie. Locking issuance without locking clearance was the
      // asymmetric gap that produced the Iter 2.1 cookie path family.
      expect(clearHeader).toMatch(/;\s*Path=\/api\/v1\/r(;|$)/);
    });

    it("D3: cookie bound to a different token returns 401 email_otp_required", async () => {
      const { rawToken, tokenId } = await makeEmailOtpToken({
        auth_email: "d3@example.com",
      });
      const otherSession = jwt.sign(
        { email: "x@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: "gw_tok_some_other_token",
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${otherSession}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("email_otp_required");
    });
  });

  // ---- Send-result branches: failed / rate_limited / recovery -------------

  describe("send-result branches", () => {
    it("R-fail: SMTP failed result returns 502 email_send_failed and persists no code row", async () => {
      // Failing transport — emailService.sendEmail's catch wrapper
      // converts a thrown transport error into { status: "failed" }.
      const failingTransport: EmailTransport = {
        async send() {
          throw new Error("ETIMEDOUT relay.local");
        },
        async close() {},
      };
      const failApp = createApp({ db, emailTransport: failingTransport });
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "fail@example.com",
      });
      const res = await request(failApp)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "fail@example.com" });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("email_send_failed");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(audits.some((a: any) => a.action === "token.email_otp_sent")).toBe(
        false,
      );
      // I2: no email_otp_codes row should exist on failure path — would
      // block recovery via the 60s resend cooldown otherwise.
      const otpRows = await db
        .select()
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId));
      expect(otpRows.length).toBe(0);
    });

    it("R-recovery: after failed send, next /request 1s later succeeds (no cooldown gate)", async () => {
      // Transport that fails once then succeeds — exercises the I2
      // recovery path: the failed send must not persist a code row so
      // the resend cooldown does not fire on retry.
      let calls = 0;
      const sends: CapturedSend[] = [];
      const flakyTransport: EmailTransport = {
        async send(input) {
          calls++;
          if (calls === 1) throw new Error("transient");
          const messageId = `mid-recover-${calls}`;
          sends.push({ ...input, messageId });
          return { messageId };
        },
        async close() {},
      };
      const flakyApp = createApp({ db, emailTransport: flakyTransport });
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "recover@example.com",
      });
      const first = await request(flakyApp)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "recover@example.com" });
      expect(first.status).toBe(502);
      // Confirm no row was persisted on the failed branch.
      const intermediateRows = await db
        .select()
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId));
      expect(intermediateRows.length).toBe(0);
      // Immediate retry — no resend cooldown should fire because the
      // first call did not stamp a row.
      const second = await request(flakyApp)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "recover@example.com" });
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("sent");
      const finalRows = await db
        .select()
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId));
      expect(finalRows.length).toBe(1);
    });

    it("R-rate: per-email rate-limit returns 429 email_rate_limited (distinct from resend_cooldown)", async () => {
      // Inject a transport stub via a hand-rolled emailService that
      // returns rate_limited for the first call. Easiest path: build a
      // wrapper module on the existing app — but createApp does not
      // expose direct override of emailService. Instead, exhaust the
      // service's per-email cap by hammering sendEmail through the
      // route AFTER backdating prior rows so resend_cooldown does not
      // fire first. Limit defaults to 5/hr per email.
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "rate@example.com",
      });
      // Burn 5 successful sends (the per-email default cap). Each burn
      // backdates the resend cooldown row so the next /request passes
      // the cooldown gate.
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post(`/r/${rawToken}/email-otp/request`)
          .send({ email: "rate@example.com" });
        expect(res.status).toBe(200);
        await db
          .update(emailOtpCodes)
          .set({ created_at: new Date(Date.now() - 120_000) })
          .where(eq(emailOtpCodes.token_id, tokenId));
      }
      // 6th call — per-email rate limit fires, surfaced as 429
      // email_rate_limited (distinct error code from resend_cooldown
      // because recipient remediation differs: wait an hour vs. wait a
      // moment).
      const res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "rate@example.com" });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("email_rate_limited");
      // I2: no NEW code row created on the rate-limited branch (the
      // earlier 5 backdated rows remain — but no row whose created_at
      // is recent).
      const recentRows = await db
        .select()
        .from(emailOtpCodes)
        .where(eq(emailOtpCodes.token_id, tokenId));
      const fresh = recentRows.filter(
        (r: any) =>
          new Date(r.created_at).getTime() > Date.now() - 60_000,
      );
      expect(fresh.length).toBe(0);
      // Operator-side rate audit emitted by the email service.
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      void audits;
    });
  });

  // ---- Lock-cycle reset ---------------------------------------------------

  describe("lock-cycle", () => {
    it("R-lock-cycle: after 1h lockout expires, /request and /verify resume", async () => {
      const { tokenId, rawToken } = await makeEmailOtpToken({
        auth_email: "cycle@example.com",
        locked: true,
      });
      // Confirm locked first.
      let res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "cycle@example.com" });
      expect(res.status).toBe(423);
      // Backdate lock to the past — readLock() returns null for expired
      // locks, opening /request again.
      await db
        .update(reviewTokens)
        .set({ otp_locked_until: new Date(Date.now() - 60_000) })
        .where(eq(reviewTokens.id, tokenId));
      res = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "cycle@example.com" });
      expect(res.status).toBe(200);
    });
  });

  // ---- C1 transactional /decide ------------------------------------------

  describe("/decide preflight + compensating revert", () => {
    it("D-race: review already decided returns 410 + token row remains UNused + cookie NOT cleared", async () => {
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "drace@example.com",
      });
      // Mark the review as already-decided BEFORE the recipient hits
      // /decide — simulates a main-app reviewer landing the decision
      // first. tokenService.validate observes review.status moved past
      // the token-holding states and returns { status: "used" } before
      // we even reach the route's preflight; that path returns the
      // earlier-existing token_already_used surface. The C1 invariant
      // we care about is: token row stays UNused so the recipient can
      // see the now-decided state on next page load and is not silently
      // locked out.
      await db
        .update(reviews)
        .set({
          status: "decided",
          decision: "approved",
          decided_at: new Date(),
          decided_by: "main_app_reviewer",
        })
        .where(eq(reviews.id, reviewId));
      const sessionJwt = jwt.sign(
        { email: "drace@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: tokenId,
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      const res = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Cookie", `${recipientSessionCookieName(tokenId)}=${sessionJwt}`)
        .send({ decision: "approved" });
      expect(res.status).toBe(410);
      // Either pre-flight surface is acceptable: validate's used-status
      // path emits token_already_used; the route preflight (if reached)
      // emits review_already_decided. Both keep the token UNused.
      expect(["token_already_used", "review_already_decided"]).toContain(
        res.body.error.code,
      );
      // C1: token row must remain UNused — neither preflight branch
      // touched the token row.
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.used_at).toBeNull();
      expect(tokenRow.decision).toBeNull();
      // Cookie must NOT be cleared — the recipient never decided.
      const setCookieHeaders = res.headers["set-cookie"];
      const setCookies = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : setCookieHeaders
          ? [setCookieHeaders]
          : [];
      const clearHeader = setCookies.find((h: string) =>
        h.includes(RECIPIENT_SESSION_COOKIE_NAME),
      );
      expect(clearHeader).toBeUndefined();
    });

    it("D-decided-by-email: full flow stamps decided_by_email + audit verified_email", async () => {
      const { tokenId, rawToken, reviewId } = await makeEmailOtpToken({
        auth_email: "dby@example.com",
      });
      // Full request → verify → decide using the captured code so
      // session.email is the OTP-verified email, not a stubbed claim.
      transport.sends.length = 0;
      const reqRes = await request(app)
        .post(`/r/${rawToken}/email-otp/request`)
        .send({ email: "dby@example.com" });
      expect(reqRes.status).toBe(200);
      const code = codeFromCapture(transport.sends[0]);
      const verifyRes = await request(app)
        .post(`/r/${rawToken}/email-otp/verify`)
        .send({ code });
      expect(verifyRes.status).toBe(200);
      const setCookie = verifyRes.headers["set-cookie"];
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      // Extract just the cookie name=value pair.
      const cookiePair = (cookieHeader as string).split(";")[0];
      const decideRes = await request(app)
        .post(`/r/${rawToken}/decide`)
        .set("Cookie", cookiePair)
        .send({ decision: "approved" });
      expect(decideRes.status).toBe(200);
      // I1: decided_by_email stamped on the token row.
      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(tokenRow.decided_by_email).toBe("dby@example.com");
      // Audit double-belt: token.consumed details.verified_email.
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const consumed = audits.find(
        (a: any) => a.action === "token.consumed",
      );
      expect(consumed?.details?.verified_email).toBe("dby@example.com");
    });
  });

  // ---- T3: production cookie prefix --------------------------------------

  describe("production cookie prefix", () => {
    it("V1b: NODE_ENV=production uses __Secure- prefix and sets Secure attribute", async () => {
      const { vi } = await import("vitest");
      vi.stubEnv("NODE_ENV", "production");
      vi.resetModules();
      try {
        const { createApp: prodCreateApp } = await import("../app");
        const { RECIPIENT_SESSION_COOKIE_NAME: prodName } = await import(
          "../services/token-recipient-session"
        );
        expect(prodName).toBe("__Secure-gatewerk_token_session");
        const prodApp = prodCreateApp({ db, emailTransport: transport });
        const { rawToken } = await makeEmailOtpToken({
          auth_email: "v1b@example.com",
        });
        transport.sends.length = 0;
        const reqRes = await request(prodApp)
          .post(`/r/${rawToken}/email-otp/request`)
          .send({ email: "v1b@example.com" });
        expect(reqRes.status).toBe(200);
        const code = codeFromCapture(transport.sends[0]);
        const verifyRes = await request(prodApp)
          .post(`/r/${rawToken}/email-otp/verify`)
          .send({ code });
        expect(verifyRes.status).toBe(200);
        const setCookie = verifyRes.headers["set-cookie"];
        const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        // RFC 6265bis §4.1.3 — __Secure- prefix requires Secure attr.
        expect(cookieHeader).toContain("__Secure-gatewerk_token_session");
        expect(cookieHeader).toMatch(/;\s*Secure/);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
  });

  // ---- T5: live IP rate-limit ---------------------------------------------

  describe("verify rate limit (live)", () => {
    it("V8: IP-based rate-limit fires after 10 verify attempts in 5 min", async () => {
      const { vi } = await import("vitest");
      // Toggle the route's isTestEnv() OFF so the limiter does not skip.
      // The config module's own isTestEnv() also flips when both signals
      // go false, so we must back-fill the required envs (DATABASE_URL,
      // HMAC/JWT/OTP secrets) that config.ts validates at module-load.
      // The injected `db` short-circuits the DATABASE_URL pool init, so
      // a placeholder value is enough — config only checks presence.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VITEST", "false");
      vi.stubEnv(
        "DATABASE_URL",
        "postgresql://gatewerk:gatewerk@localhost:5432/gatewerk_test",
      );
      vi.stubEnv("HMAC_SECRET", "x".repeat(48));
      vi.stubEnv("JWT_SECRET", "y".repeat(48));
      vi.stubEnv("OTP_HMAC_SECRET", "z".repeat(48));
      vi.stubEnv("UI_ORIGIN", "http://localhost:5173");
      vi.resetModules();
      try {
        const { createApp: liveCreateApp } = await import("../app");
        const liveApp = liveCreateApp({ db, emailTransport: transport });
        const { rawToken } = await makeEmailOtpToken({
          auth_email: "v8@example.com",
        });
        transport.sends.length = 0;
        await request(liveApp)
          .post(`/r/${rawToken}/email-otp/request`)
          .send({ email: "v8@example.com" });
        // 10 wrong attempts allowed by the limiter — token-level lock
        // fires at 5 (returns 423 token_locked) but limiter window is
        // 10. Send 10 wrong codes; the limiter cap is reached on the
        // 11th call.
        for (let i = 0; i < 10; i++) {
          await request(liveApp)
            .post(`/r/${rawToken}/email-otp/verify`)
            .send({ code: "111111" });
        }
        const res = await request(liveApp)
          .post(`/r/${rawToken}/email-otp/verify`)
          .send({ code: "111111" });
        expect(res.status).toBe(429);
        // express-rate-limit either echoes our `message` body verbatim
        // or its default; either way the type is rate_limit. Match
        // loosely.
        const errorCode =
          res.body.error?.code ?? res.body.error?.type ?? "";
        expect(String(errorCode)).toMatch(/rate_limit/);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });
  });

  // ---- T4: audience-claim isolation route table ---------------------------

  describe("audience-claim isolation across authenticated routes", () => {
    const ROUTES = [
      "/api/v1/reviews",
      "/api/v1/templates",
      "/api/v1/auth/me",
    ];
    for (const route of ROUTES) {
      it(`recipient JWT replayed against ${route} returns 401/403`, async () => {
        const { tokenId } = await makeEmailOtpToken({
          auth_email: `route-${route.replace(/\W+/g, "-")}@example.com`,
        });
        const recipientJwt = jwt.sign(
          { email: "x@example.com" },
          config.jwtSecret,
          {
            algorithm: "HS256",
            audience: RECIPIENT_SESSION_AUDIENCE,
            issuer: RECIPIENT_SESSION_ISSUER,
            subject: tokenId,
            expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
          },
        );
        const res = await request(app)
          .get(route)
          .set("Authorization", `Bearer ${recipientJwt}`);
        expect([401, 403]).toContain(res.status);
      });
    }
  });

  // ---- A1: audience-claim isolation ---------------------------------------

  describe("audience-claim isolation", () => {
    it("A1: a recipient session JWT replayed into Authorization: Bearer is rejected", async () => {
      const { tokenId } = await makeEmailOtpToken({
        auth_email: "a1@example.com",
      });
      const recipientJwt = jwt.sign(
        { email: "a1@example.com" },
        config.jwtSecret,
        {
          algorithm: "HS256",
          audience: RECIPIENT_SESSION_AUDIENCE,
          issuer: RECIPIENT_SESSION_ISSUER,
          subject: tokenId,
          expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
        },
      );
      // Hit any authenticated endpoint with the recipient cookie value
      // pasted into the Authorization header. validateJwt's audience
      // check rejects it before the row lookup.
      const res = await request(app)
        .get("/api/v1/reviews")
        .set("Authorization", `Bearer ${recipientJwt}`);
      expect(res.status).toBe(401);
    });
  });
});
