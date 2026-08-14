import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { EventBus, type EventData } from "../services/events";
import { createReviewTokenService } from "../services/review-tokens";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import {
  reviewTokens,
  reviews,
  templates,
  notes,
  noteAttachments,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_TTL_SECONDS,
  RECIPIENT_SESSION_COOKIE_NAME,
  recipientSessionCookieName,
} from "../services/token-recipient-session";

/**
 * Recipient-action surface (token redesign §7 E3 + E4): Decline +
 * Send-questions. Mirrors email-otp-recipient-flow.test.ts and
 * account-tier-recipient-flow.test.ts shape — direct DB token insert
 * sidesteps the routes-layer create gate that does not yet expose this
 * surface to clients, supertest exercises the consumer surface.
 *
 * Locks: review reverts to pending (NOT rejected per spec §7 E3),
 * decision stays NULL, used_at set, decided_by_* stamped per tier,
 * note created, audit emitted.
 */

describe("recipient-action surface (decline + raise-questions)", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;

  type Tier = "public" | "email_otp" | "account";

  async function makeToken(opts: {
    tier: Tier;
    auth_email?: string;
    auth_user_id?: string;
    used?: boolean;
    revoked?: boolean;
    expired?: boolean;
    preview?: boolean;
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
    const rawToken = `gw_tok_${tokenId.slice(7)}_test`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await db.insert(reviewTokens).values({
      id: tokenId,
      token_hash: tokenHash,
      review_id: rev.id,
      project_id: projectId,
      expires_at: opts.expired
        ? new Date(Date.now() - 1000)
        : new Date(Date.now() + 24 * 60 * 60 * 1000),
      purpose: "test",
      recipient_label: "Acme Reviewer",
      auth_level: opts.tier,
      auth_email: opts.auth_email ?? null,
      auth_user_id: opts.auth_user_id ?? null,
      created_by_kind: "manual",
      created_by_id: "test",
      is_preview: opts.preview ?? false,
      used_at: opts.used ? new Date() : null,
      revoked_at: opts.revoked ? new Date() : null,
      revoked_by: opts.revoked ? "test" : null,
    });
    return { tokenId, rawToken, reviewId: rev.id };
  }

  function emailOtpCookie(tokenId: string, email: string): string {
    const sessionJwt = jwt.sign(
      { email },
      config.jwtSecret,
      {
        algorithm: "HS256",
        audience: RECIPIENT_SESSION_AUDIENCE,
        issuer: RECIPIENT_SESSION_ISSUER,
        subject: tokenId,
        expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
      },
    );
    return `${recipientSessionCookieName(tokenId)}=${sessionJwt}`;
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
        slug: "recipient-actions-test",
        project_id: projectId,
        name: "Recipient Actions Test",
        fields: [{ name: "subject", type: "text", label: "Subject" }],
        actions: ["approve", "reject"],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db });

    const aliceSeed = await seedReviewer(db, app, {
      email: "alice@recipient-actions-test.local",
      name: "Alice",
    });
    aliceId = aliceSeed.reviewer.id;
    aliceToken = aliceSeed.sessionToken;

    const bobSeed = await seedReviewer(db, app, {
      email: "bob@recipient-actions-test.local",
      name: "Bob",
    });
    bobToken = bobSeed.sessionToken;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // ---- Decline ------------------------------------------------------------

  describe("POST /r/:token/decline", () => {
    it("D1: public-tier decline succeeds → 200, review.status=pending, token.used_at set, decision=null, note created, audit token.declined", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("declined");

      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("pending");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).not.toBeNull();
      expect(tokenRow.decision).toBeNull();
      expect(tokenRow.decided_by_email).toBeNull();
      expect(tokenRow.decided_by_user_id).toBeNull();

      const noteRows = await db
        .select()
        .from(notes)
        .where(eq(notes.project_id, projectId));
      const declineNote = noteRows.find((n: any) =>
        n.body.startsWith("Declined by Acme Reviewer"),
      );
      expect(declineNote).toBeTruthy();
      expect(declineNote.body).toBe("Declined by Acme Reviewer");
      expect(declineNote.is_shared).toBe(true);
      expect(declineNote.tags).toEqual(["external"]);
      expect(declineNote.author_id).toBeNull();
      expect(declineNote.author_display_fallback).toBe(
        "recipient:Acme Reviewer",
      );

      // Verify the note is bound to the review via note_attachments
      // (canonical Phase A notes layer; reviewers see this in the review's
      // notes panel via the GET /api/v1/reviews/:id/notes shim).
      const attRows = await db
        .select()
        .from(noteAttachments)
        .where(eq(noteAttachments.note_id, declineNote.id));
      expect(attRows.length).toBe(1);
      expect(attRows[0].target_kind).toBe("review");
      expect(attRows[0].target_id).toBe(reviewId);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const declined = audits.find((a: any) => a.action === "token.declined");
      expect(declined).toBeTruthy();
      expect(declined.details.recipient_label).toBe("Acme Reviewer");
      expect(declined.details.auth_level).toBe("public");
    });

    it("D2: public-tier decline with reason includes ': [reason]' in note body and decline_reason in audit", async () => {
      const { rawToken, reviewId } = await makeToken({ tier: "public" });
      const res = await request(app)
        .post(`/r/${rawToken}/decline`)
        .send({ decline_reason: "out of office until next week" });
      expect(res.status).toBe(200);

      const noteRows = await db
        .select()
        .from(notes)
        .where(eq(notes.project_id, projectId));
      const declineNote = noteRows.find((n: any) =>
        n.body.includes("out of office"),
      );
      expect(declineNote.body).toBe(
        "Declined by Acme Reviewer: out of office until next week",
      );

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const declined = audits.find((a: any) => a.action === "token.declined");
      expect(declined.details.decline_reason).toBe(
        "out of office until next week",
      );
    });

    it("D3: email_otp decline WITHOUT verified cookie returns 401 email_otp_required and does not consume the token", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({
        tier: "email_otp",
        auth_email: "d3@example.com",
      });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("email_otp_required");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("awaiting_external");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.find((a: any) => a.action === "token.declined"),
      ).toBeUndefined();
    });

    it("D4: email_otp decline WITH verified cookie returns 200, decided_by_email set, cookie cleared", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({
        tier: "email_otp",
        auth_email: "d4@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/decline`)
        .set("Cookie", emailOtpCookie(tokenId, "d4@example.com"))
        .send({});
      expect(res.status).toBe(200);

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.decided_by_email).toBe("d4@example.com");
      expect(tokenRow.decision).toBeNull();

      const setCookieHeaders = res.headers["set-cookie"];
      const setCookies = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];
      const clearHeader = setCookies.find((h: string | undefined) =>
        h?.includes(RECIPIENT_SESSION_COOKIE_NAME),
      );
      expect(clearHeader).toBeTruthy();
      expect(clearHeader).toMatch(/(Max-Age=0|Expires=)/);
      expect(clearHeader).toMatch(/;\s*Path=\/api\/v1\/r(;|$)/);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const declined = audits.find((a: any) => a.action === "token.declined");
      expect(declined.details.auth_level).toBe("email_otp");
      expect(declined.details.verified_email).toBe("d4@example.com");
    });

    it("D5: account-tier decline WITHOUT bearer JWT returns 401 account_login_required and does not consume the token", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({
        tier: "account",
        auth_user_id: aliceId,
      });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("account_login_required");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("awaiting_external");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.find((a: any) => a.action === "token.declined"),
      ).toBeUndefined();
    });

    it("D6: account-tier decline with mismatched user returns 401 account_mismatch", async () => {
      const { tokenId, rawToken } = await makeToken({
        tier: "account",
        auth_user_id: aliceId,
      });
      const res = await request(app)
        .post(`/r/${rawToken}/decline`)
        .set("Authorization", `Bearer ${bobToken}`)
        .send({});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("account_mismatch");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
    });

    it("D7: account-tier decline with matching user returns 200, decided_by_user_id stamped, audit auth_level=account", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({
        tier: "account",
        auth_user_id: aliceId,
      });
      const res = await request(app)
        .post(`/r/${rawToken}/decline`)
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({});
      expect(res.status).toBe(200);

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.decided_by_user_id).toBe(aliceId);
      expect(tokenRow.decision).toBeNull();

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const declined = audits.find((a: any) => a.action === "token.declined");
      expect(declined.details.auth_level).toBe("account");
      expect(declined.details.decided_by_user_id).toBe(aliceId);

      const accountDecided = audits.find(
        (a: any) => a.action === "token.account_decided",
      );
      expect(accountDecided).toBeTruthy();
      expect(accountDecided.details.action_kind).toBe("declined");
      expect(accountDecided.details.decided_by_user_id).toBe(aliceId);
    });

    it("D8: already-used token returns 410 token_already_used", async () => {
      const { rawToken } = await makeToken({ tier: "public", used: true });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("token_already_used");
    });

    it("D9: preview token cannot be spent by decline (server-side, not just the UI)", async () => {
      const { rawToken, tokenId } = await makeToken({ tier: "public", preview: true });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("token_is_preview");

      // The link must survive: a preview is for looking, and spending it would
      // consume the sender's own token and revert the review.
      const [row] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(row.used_at).toBeNull();
    });
  });

  // ---- Raise questions ----------------------------------------------------

  describe("POST /r/:token/raise-questions", () => {
    it("Q0: preview token cannot be spent by raise-questions", async () => {
      const { rawToken, tokenId } = await makeToken({ tier: "public", preview: true });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({ question_text: "Does the preview link stay unspent?" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("token_is_preview");

      const [row] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId));
      expect(row.used_at).toBeNull();
    });

    it("Q1: public-tier with valid text returns 200, review.status=pending, token consumed, note created, audit token.questions_raised", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({
          question_text: "Could you clarify the timeline for the rollout?",
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("questions_raised");

      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("pending");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).not.toBeNull();
      expect(tokenRow.decision).toBeNull();

      const noteRows = await db
        .select()
        .from(notes)
        .where(eq(notes.project_id, projectId));
      const questionNote = noteRows.find((n: any) =>
        n.body.startsWith("Acme Reviewer asked:"),
      );
      expect(questionNote).toBeTruthy();
      expect(questionNote.body).toBe(
        "Acme Reviewer asked: Could you clarify the timeline for the rollout?",
      );
      expect(questionNote.author_display_fallback).toBe(
        "recipient:Acme Reviewer",
      );

      const attRows = await db
        .select()
        .from(noteAttachments)
        .where(eq(noteAttachments.note_id, questionNote.id));
      expect(attRows.length).toBe(1);
      expect(attRows[0].target_kind).toBe("review");
      expect(attRows[0].target_id).toBe(reviewId);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const raised = audits.find(
        (a: any) => a.action === "token.questions_raised",
      );
      expect(raised).toBeTruthy();
      expect(raised.details.recipient_label).toBe("Acme Reviewer");
      expect(raised.details.question_text).toBe(
        "Could you clarify the timeline for the rollout?",
      );
      expect(raised.details.auth_level).toBe("public");
    });

    it("Q2: missing question_text returns 422 validation_failed and preserves review state", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("awaiting_external");
      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.find((a: any) => a.action === "token.questions_raised"),
      ).toBeUndefined();
    });

    it("Q3: question_text too short (< 10 chars) returns 422 and preserves state", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({ question_text: "short" });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("awaiting_external");
    });

    it("Q4: question_text too long (> 5000 chars) returns 422 and preserves state", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      const tooLong = "a".repeat(5001);
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({ question_text: tooLong });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("awaiting_external");
    });

    it("Q5: email_otp with verified cookie returns 200, decided_by_email stamped, cookie cleared", async () => {
      const { tokenId, rawToken } = await makeToken({
        tier: "email_otp",
        auth_email: "q5@example.com",
      });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .set("Cookie", emailOtpCookie(tokenId, "q5@example.com"))
        .send({ question_text: "Need more context on the customer impact." });
      expect(res.status).toBe(200);

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.decided_by_email).toBe("q5@example.com");

      const setCookieHeaders = res.headers["set-cookie"];
      const setCookies = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];
      const clearHeader = setCookies.find((h: string | undefined) =>
        h?.includes(RECIPIENT_SESSION_COOKIE_NAME),
      );
      expect(clearHeader).toBeTruthy();
      expect(clearHeader).toMatch(/(Max-Age=0|Expires=)/);
      expect(clearHeader).toMatch(/;\s*Path=\/api\/v1\/r(;|$)/);
    });

    it("Q6: account-tier with matching user returns 200, decided_by_user_id stamped, token.account_decided emitted", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({
        tier: "account",
        auth_user_id: aliceId,
      });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .set("Authorization", `Bearer ${aliceToken}`)
        .send({ question_text: "Could you share the original RFC link?" });
      expect(res.status).toBe(200);

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.decided_by_user_id).toBe(aliceId);

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      const accountDecided = audits.find(
        (a: any) => a.action === "token.account_decided",
      );
      expect(accountDecided).toBeTruthy();
      expect(accountDecided.details.action_kind).toBe("questions_raised");
      expect(accountDecided.details.decided_by_user_id).toBe(aliceId);
    });
  });

  // ---- Cross-cutting -------------------------------------------------------

  describe("cross-cutting token state", () => {
    it("C1: revoked token returns 410 token_revoked on decline", async () => {
      const { rawToken } = await makeToken({ tier: "public", revoked: true });
      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("token_revoked");
    });

    it("C2: expired token returns 410 token_expired on raise-questions", async () => {
      const { rawToken } = await makeToken({ tier: "public", expired: true });
      const res = await request(app)
        .post(`/r/${rawToken}/raise-questions`)
        .send({ question_text: "Question on expired token." });
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe("token_expired");
    });

    // D-CONCURRENT: TOCTOU defense — a concurrent main-app /decide that
    // has already moved the review to `decided` between the recipient's
    // validate() pass and this consume must NOT silently overwrite the
    // decision. We exercise the txn-level guard directly on the service
    // because validate() and the txn lock acquisition cannot be
    // synchronized through supertest; the service-level test precisely
    // covers the TOCTOU window.
    it("D-CONCURRENT: review flipped to decided between validate and txn → service returns review_already_decided, token NOT consumed", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      // Flip the review out of an active token-holding state to simulate
      // a concurrent /decide that landed first.
      await db
        .update(reviews)
        .set({ status: "decided" })
        .where(eq(reviews.id, reviewId));

      const tokenService = createReviewTokenService(db);
      const result = await tokenService.consumeAsRecipientAction(rawToken, {
        kind: "declined",
        ip_address: "127.0.0.1",
        user_agent: "test",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("review_already_decided");
      }

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      expect(tokenRow.decision).toBeNull();

      const [reviewRow] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .limit(1);
      expect(reviewRow.status).toBe("decided");
    });

    // ---- Observability (Plan 6 C1) -----------------------------------------

    describe("recipient-action observability (Plan 6 C1)", () => {
      it("C1-WH-DECLINE: webhook fires with type=review.sent_back (NOT review.decided) and review stays pending", async () => {
        const capturedCalls: { url: string; body: Record<string, unknown> }[] = [];
        const spyFetch = vi.fn(async (url: string, opts: RequestInit) => {
          capturedCalls.push({ url: String(url), body: JSON.parse(String(opts.body)) });
          return new Response("ok");
        }) as unknown as typeof globalThis.fetch;

        const appWithSpy = createApp({ db, fetchForWebhook: spyFetch });

        const reviewId = generateId("review");
        await db.insert(reviews).values({
          id: reviewId,
          project_id: projectId,
          template_id: templateId,
          template_slug: templateSlug,
          payload: { subject: "observability test" },
          status: "awaiting_external",
          callback_url: "https://agent.example.com/cb",
        });

        const tokenId = generateId("token");
        const { createHash } = await import("node:crypto");
        const rawToken = `gw_tok_${tokenId.slice(7)}_c1wh`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        await db.insert(reviewTokens).values({
          id: tokenId,
          token_hash: tokenHash,
          review_id: reviewId,
          project_id: projectId,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          purpose: "test",
          recipient_label: "Spy Reviewer",
          auth_level: "public",
          auth_email: null,
          auth_user_id: null,
          created_by_kind: "manual",
          created_by_id: "test",
          used_at: null,
          revoked_at: null,
          revoked_by: null,
        });

        const res = await request(appWithSpy)
          .post(`/r/${rawToken}/decline`)
          .send({ decline_reason: "Need more info" });
        expect(res.status).toBe(200);

        const [reviewRow] = await db
          .select()
          .from(reviews)
          .where(eq(reviews.id, reviewId))
          .limit(1);
        expect(reviewRow.status).toBe("pending");

        await new Promise((r) => setTimeout(r, 50));
        const sentBackCall = capturedCalls.find(
          (c) => c.body.type === "review.sent_back",
        );
        expect(sentBackCall).toBeTruthy();
        expect(sentBackCall!.body.type).toBe("review.sent_back");
        expect(sentBackCall!.body.type).not.toBe("review.decided");
        expect(sentBackCall!.body.review_id).toBe(reviewId);
        expect(sentBackCall!.body.recipient_label).toBe("Spy Reviewer");
        expect(sentBackCall!.body.decline_reason).toBe("Need more info");
      });

      it("C1-WH-QUESTIONS: webhook fires with type=review.questions_raised (NOT review.decided) and review stays pending", async () => {
        const capturedCalls: { url: string; body: Record<string, unknown> }[] = [];
        const spyFetch = vi.fn(async (url: string, opts: RequestInit) => {
          capturedCalls.push({ url: String(url), body: JSON.parse(String(opts.body)) });
          return new Response("ok");
        }) as unknown as typeof globalThis.fetch;

        const appWithSpy = createApp({ db, fetchForWebhook: spyFetch });

        const reviewId = generateId("review");
        await db.insert(reviews).values({
          id: reviewId,
          project_id: projectId,
          template_id: templateId,
          template_slug: templateSlug,
          payload: { subject: "questions observability test" },
          status: "awaiting_external",
          callback_url: "https://agent.example.com/cb",
        });

        const tokenId = generateId("token");
        const { createHash } = await import("node:crypto");
        const rawToken = `gw_tok_${tokenId.slice(7)}_c1qr`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        await db.insert(reviewTokens).values({
          id: tokenId,
          token_hash: tokenHash,
          review_id: reviewId,
          project_id: projectId,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          purpose: "test",
          recipient_label: "Spy Reviewer",
          auth_level: "public",
          auth_email: null,
          auth_user_id: null,
          created_by_kind: "manual",
          created_by_id: "test",
          used_at: null,
          revoked_at: null,
          revoked_by: null,
        });

        const res = await request(appWithSpy)
          .post(`/r/${rawToken}/raise-questions`)
          .send({ question_text: "Could you clarify the rollout timeline?" });
        expect(res.status).toBe(200);

        const [reviewRow] = await db
          .select()
          .from(reviews)
          .where(eq(reviews.id, reviewId))
          .limit(1);
        expect(reviewRow.status).toBe("pending");

        await new Promise((r) => setTimeout(r, 50));
        const qrCall = capturedCalls.find(
          (c) => c.body.type === "review.questions_raised",
        );
        expect(qrCall).toBeTruthy();
        expect(qrCall!.body.type).toBe("review.questions_raised");
        expect(qrCall!.body.type).not.toBe("review.decided");
        expect(qrCall!.body.review_id).toBe(reviewId);
        expect(qrCall!.body.recipient_label).toBe("Spy Reviewer");
        expect(qrCall!.body.question_text).toBe("Could you clarify the rollout timeline?");
      });

      it("C1-NO-CB: when no callback_url, no webhook fires but the SSE event still emits + review reverts to pending", async () => {
        const capturedCalls: { url: string }[] = [];
        const spyFetch = vi.fn(async (url: string) => {
          capturedCalls.push({ url: String(url) });
          return new Response("ok");
        }) as unknown as typeof globalThis.fetch;

        // Real EventBus with a listener — in-app / SSE observability must fire
        // regardless of whether callback_url (outbound HTTP) is configured.
        const bus = new EventBus();
        const emitted: { event: string; data: EventData }[] = [];
        bus.on("review.sent_back", (data) => {
          emitted.push({ event: "review.sent_back", data });
        });

        const appWithSpy = createApp({
          db,
          eventBus: bus,
          fetchForWebhook: spyFetch,
        });

        const reviewId = generateId("review");
        await db.insert(reviews).values({
          id: reviewId,
          project_id: projectId,
          template_id: templateId,
          template_slug: templateSlug,
          payload: { subject: "no callback test" },
          status: "awaiting_external",
        });

        const tokenId = generateId("token");
        const { createHash } = await import("node:crypto");
        const rawToken = `gw_tok_${tokenId.slice(7)}_c1nc`;
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        await db.insert(reviewTokens).values({
          id: tokenId,
          token_hash: tokenHash,
          review_id: reviewId,
          project_id: projectId,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          purpose: "test",
          recipient_label: "Spy Reviewer",
          auth_level: "public",
          auth_email: null,
          auth_user_id: null,
          created_by_kind: "manual",
          created_by_id: "test",
          used_at: null,
          revoked_at: null,
          revoked_by: null,
        });

        const res = await request(appWithSpy).post(`/r/${rawToken}/decline`).send({});
        expect(res.status).toBe(200);

        const [reviewRow] = await db
          .select()
          .from(reviews)
          .where(eq(reviews.id, reviewId))
          .limit(1);
        expect(reviewRow.status).toBe("pending");
        await new Promise((r) => setTimeout(r, 50));
        expect(capturedCalls.length).toBe(0);

        // SSE / in-app observability fires even with a null callback_url.
        const sentBack = emitted.find((e) => e.event === "review.sent_back");
        expect(sentBack).toBeTruthy();
        expect(sentBack!.data.review_id).toBe(reviewId);
      });
    });

    // D-CONCURRENT-2: route-level mapping — when the service surfaces the
    // race (here we pre-flip status before the request so validate() also
    // routes it as terminal), the recipient never sees a 200/declined
    // outcome that would have overwritten the decision. validate() filters
    // first as 410 token_already_used; the txn guard is a defense-in-depth
    // layer for the narrower race where validate succeeds.
    it("D-CONCURRENT-2: pre-decided review on /decline route returns terminal error, token NOT consumed", async () => {
      const { tokenId, rawToken, reviewId } = await makeToken({ tier: "public" });
      await db
        .update(reviews)
        .set({ status: "decided" })
        .where(eq(reviews.id, reviewId));

      const res = await request(app).post(`/r/${rawToken}/decline`).send({});
      // 409 from the txn guard if validate() raced through, or 410 from
      // validate's own status check — either is a correct refusal that
      // does NOT overwrite the decision. Both routes must leave the token
      // unconsumed.
      expect([409, 410]).toContain(res.status);

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.id, tokenId))
        .limit(1);
      expect(tokenRow.used_at).toBeNull();
      expect(tokenRow.decision).toBeNull();

      const audits = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resource_id, reviewId));
      expect(
        audits.find((a: any) => a.action === "token.declined"),
      ).toBeUndefined();
    });
  });

});
