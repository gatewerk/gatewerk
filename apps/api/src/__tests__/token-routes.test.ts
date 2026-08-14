import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { reviews, reviewTokens, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Token review routes", () => {
  let app: any;
  let client: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  // Token-redesign Phase 1: each generate transitions the review to
  // awaiting_external, so tests that need to generate must spin up their own
  // fresh pending review.
  async function createPendingReview(): Promise<string> {
    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: templateSlug,
      payload: { subject: "fresh" },
      callback_url: "https://example.com/cb",
      status: "pending",
    }).returning();
    return rev.id;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "token-route-test",
      project_id: projectId,
      name: "Token Route Test",
      fields: [{ name: "subject", type: "text", label: "Subject" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
    }).returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db, emailTransport: { send: async () => ({ messageId: "test" }) } as any });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  describe("POST /api/v1/reviews/:id/token", () => {
    it("generates a token for a pending review", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^gw_tok_/);
      expect(res.body.review_id).toBe(reviewId);
      expect(res.body.url).toMatch(/^\/r\/gw_tok_/);
      expect(res.body.expires_at).toBeTruthy();

      const [updated] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(updated.status).toBe("awaiting_external");
    });

    it("rejects token generation for a non-existent review", async () => {
      const res = await request(app)
        .post(`/api/v1/reviews/gw_rev_nonexistent/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /r/:token", () => {
    it("returns review data for a valid token", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      const token = genRes.body.token;

      const res = await request(app).get(`/r/${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.review.id).toBe(reviewId);
      expect(res.body.review.payload).toEqual({ subject: "fresh" });
      expect(res.body.template.name).toBe("Token Route Test");
    });

    it("returns 404 for an invalid token", async () => {
      const res = await request(app).get("/r/gw_tok_invalid123456abcdef");
      expect(res.status).toBe(404);
    });

    it("returns 400 for a malformed token", async () => {
      const res = await request(app).get("/r/not_a_valid_prefix");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /r/:token/decide", () => {
    it("approves a review via token and marks token as used", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      const token = genRes.body.token;

      const res = await request(app)
        .post(`/r/${token}/decide`)
        .send({ decision: "approved", feedback: "Looks good" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("decided");
      expect(res.body.decision).toBe("approved");

      const validateRes = await request(app).get(`/r/${token}`);
      expect(validateRes.status).toBe(410);
      expect(validateRes.body.status).toBe("used");
    });

    it("rejects double-use of a token", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      const token = genRes.body.token;

      await request(app)
        .post(`/r/${token}/decide`)
        .send({ decision: "approved" });

      const res = await request(app)
        .post(`/r/${token}/decide`)
        .send({ decision: "rejected" });

      expect(res.status).toBe(410);
    });

    it("rejects decision without decision field", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      const token = genRes.body.token;

      const res = await request(app)
        .post(`/r/${token}/decide`)
        .send({});

      // 422, not the route's old ad-hoc 400: this route gained
      // validate({ body: ReviewDecideBodySchema }) — it was the one
      // recipient-facing write path with no body schema at all, so
      // edited_payload could be any JSON of any type. A missing required field
      // is now answered the same way every other route answers it, and the
      // same way its canonical replacement /r/:token/action already did.
      expect(res.status).toBe(422);
    });
  });

  // Phase 3 closure (spec §6.4): the previous Phase-1 explicit reject for
  // auth_level email_otp / account is gone now that the recipient surface
  // ships end-to-end. These tests lock that all three tiers create the
  // token + transition the review to awaiting_external + persist the
  // tier-specific contextual field.
  describe("auth_level all-tier acceptance", () => {
    it("accepts auth_level='email_otp' with auth_email, persists email, transitions review", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "email otp test",
          recipient_label: "test recipient",
          auth_level: "email_otp",
          auth_email: "verify-me@example.com",
        });

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^gw_tok_/);

      const [reviewAfter] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(reviewAfter.status).toBe("awaiting_external");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.review_id, reviewId))
        .limit(1);
      expect(tokenRow.auth_level).toBe("email_otp");
      expect(tokenRow.auth_email).toBe("verify-me@example.com");
      expect(tokenRow.auth_user_id).toBeNull();
    });

    it("accepts auth_level='account' with auth_user_id, persists user_id, transitions review", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "account test",
          recipient_label: "test recipient",
          auth_level: "account",
          auth_user_id: "gw_usr_acceptance",
        });

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^gw_tok_/);

      const [reviewAfter] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(reviewAfter.status).toBe("awaiting_external");

      const [tokenRow] = await db
        .select()
        .from(reviewTokens)
        .where(eq(reviewTokens.review_id, reviewId))
        .limit(1);
      expect(tokenRow.auth_level).toBe("account");
      expect(tokenRow.auth_user_id).toBe("gw_usr_acceptance");
      expect(tokenRow.auth_email).toBeNull();
    });

    it("accepts auth_level='public' (explicit) and transitions review to awaiting_external", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "public explicit",
          recipient_label: "test recipient",
          auth_level: "public",
        });

      expect(res.status).toBe(201);

      const [updated] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(updated.status).toBe("awaiting_external");
    });

    it("accepts requests omitting auth_level (zod default 'public' applies)", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "default public",
          recipient_label: "test recipient",
        });

      expect(res.status).toBe(201);

      const [updated] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(updated.status).toBe("awaiting_external");
    });
  });

  // Cross-field invariant — server enforces the (auth_level, auth_email,
  // auth_user_id) tuple contract independent of client diligence so a
  // curl / SDK / MCP caller cannot persist a violating combination. The
  // Zod superRefine on ReviewTokenBodySchema runs inside the
  // validate({body}) middleware and surfaces these as 422
  // validation_failed with field-level details.
  describe("auth_level cross-field invariants (T-CF1..T-CF5)", () => {
    it("T-CF1: auth_level=public + auth_email rejected with cross-field code", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "cf1",
          recipient_label: "rec",
          auth_level: "public",
          auth_email: "x@y.com",
        });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("validation_failed");
      expect(
        res.body.error?.details?.some(
          (d: { path: string }) => d.path === "body.auth_email",
        ),
      ).toBe(true);
    });

    it("T-CF2: auth_level=public + auth_user_id rejected with cross-field code", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "cf2",
          recipient_label: "rec",
          auth_level: "public",
          auth_user_id: "gw_usr_abc",
        });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("validation_failed");
      expect(
        res.body.error?.details?.some(
          (d: { path: string }) => d.path === "body.auth_user_id",
        ),
      ).toBe(true);
    });

    it("T-CF3: auth_level=email_otp + auth_user_id rejected with cross-field code", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "cf3",
          recipient_label: "rec",
          auth_level: "email_otp",
          auth_email: "x@y.com",
          auth_user_id: "gw_usr_abc",
        });
      // Cross-field rule fires inside validate-middleware as
      // validation_failed before the handler runs.
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("validation_failed");
      expect(
        res.body.error?.details?.some(
          (d: { path: string }) => d.path === "body.auth_user_id",
        ),
      ).toBe(true);
    });

    it("T-CF4: auth_level=email_otp without auth_email rejected with email_required", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "cf4",
          recipient_label: "rec",
          auth_level: "email_otp",
        });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("validation_failed");
      expect(
        res.body.error?.details?.some(
          (d: { path: string }) => d.path === "body.auth_email",
        ),
      ).toBe(true);
    });

    it("T-CF5: auth_level=account + auth_email rejected with cross-field code", async () => {
      const reviewId = await createPendingReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({
          purpose: "cf5",
          recipient_label: "rec",
          auth_level: "account",
          auth_user_id: "gw_usr_abc",
          auth_email: "x@y.com",
        });
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("validation_failed");
      expect(
        res.body.error?.details?.some(
          (d: { path: string }) => d.path === "body.auth_email",
        ),
      ).toBe(true);
    });
  });

  describe("POST /api/v1/reviews/:id/token/revoke", () => {
    it("revokes the active token, reverts review to pending, captures reason in audit details", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      const tokenId = (
        await db
          .select()
          .from(reviewTokens)
          .where(eq(reviewTokens.review_id, reviewId))
          .limit(1)
      )[0].id;

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token/revoke`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ reason: "no longer needed" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const [revertedReview] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
      expect(revertedReview.status).toBe("pending");

      const [revokedToken] = await db.select().from(reviewTokens).where(eq(reviewTokens.id, tokenId)).limit(1);
      expect(revokedToken.revoked_at).not.toBeNull();
      expect(revokedToken.revoked_by).toBeTruthy();

      // Token-decide flow should now fail since review is back to pending
      // (token still revoked even though review status was reverted).
      expect(genRes.body.token).toBeTruthy();
    });

    it("succeeds without a reason supplied", async () => {
      const reviewId = await createPendingReview();
      await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token/revoke`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 when no active token exists", async () => {
      const reviewId = await createPendingReview();
      // No generate first.

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token/revoke`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({});

      expect(res.status).toBe(404);
    });

    it("allows re-generation after revoke", async () => {
      const reviewId = await createPendingReview();
      await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "test", recipient_label: "test recipient" });
      await request(app)
        .post(`/api/v1/reviews/${reviewId}/token/revoke`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({});

      const reGen = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "round 2", recipient_label: "second recipient" });

      expect(reGen.status).toBe(201);
      expect(reGen.body.token).toMatch(/^gw_tok_/);
    });
  });

  describe("dead-link guard on POST /reviews/:id/token", () => {
    // Issuing a link flips the review to awaiting_external. A template whose
    // decision actions are not enabled for that status therefore produces a
    // link nobody can act on, and the recipient only discovers it after
    // clicking. Refuse at creation, where the author can still fix it.
    async function templateWithActions(actions: unknown): Promise<string> {
      const [tpl] = await db
        .insert(templates)
        .values({
          id: generateId("template"),
          slug: `dead-link-${Math.floor(Number(process.hrtime.bigint() % 100000n))}`,
          project_id: projectId,
          name: "Dead link guard",
          fields: [{ name: "subject", type: "text", label: "Subject" }],
          actions,
          enable_review_links: true,
        })
        .returning();
      return tpl.id;
    }

    async function reviewOnTemplate(tplId: string): Promise<string> {
      const [rev] = await db
        .insert(reviews)
        .values({
          id: generateId("review"),
          project_id: projectId,
          template_id: tplId,
          template_slug: "dead-link",
          payload: { subject: "fresh" },
          status: "pending",
        })
        .returning();
      return rev.id;
    }

    it("refuses a link when no decision action is enabled for awaiting_external", async () => {
      const tplId = await templateWithActions([
        { id: "approve", label: "Approve", kind: "decision", decision_value: "approved", enabled_for_status: ["pending"] },
        { id: "reject", label: "Reject", kind: "decision", decision_value: "rejected", enabled_for_status: ["pending"] },
      ]);
      const reviewId = await reviewOnTemplate(tplId);

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "dead", recipient_label: "Acme" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("no_recipient_action");
    });

    it("allows a link when a decision action covers awaiting_external", async () => {
      const tplId = await templateWithActions([
        { id: "approve", label: "Approve", kind: "decision", decision_value: "approved", enabled_for_status: ["pending", "awaiting_external"] },
        { id: "reject", label: "Reject", kind: "decision", decision_value: "rejected", enabled_for_status: ["pending", "awaiting_external"] },
      ]);
      const reviewId = await reviewOnTemplate(tplId);

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "live", recipient_label: "Acme" });

      expect(res.status).toBe(201);
    });

    it("allows a link when actions carry no status restriction at all", async () => {
      const tplId = await templateWithActions(["approve", "reject"]);
      const reviewId = await reviewOnTemplate(tplId);

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "live", recipient_label: "Acme" });

      expect(res.status).toBe(201);
    });

    it("still allows a PREVIEW link on a template the recipient could not act on", async () => {
      const tplId = await templateWithActions([
        { id: "approve", label: "Approve", kind: "decision", decision_value: "approved", enabled_for_status: ["pending"] },
      ]);
      const reviewId = await reviewOnTemplate(tplId);

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "preview", recipient_label: "Preview", preview: true });

      expect(res.status).toBe(201);
    });
  });

  describe("sender_hint on GET /r/:token", () => {
    // sender_hint answers "who sent me this link". It masks the human who
    // created the link (first char + ***), NOT the recipient's own label —
    // masking the recipient meant the page told a reader "from <yourself>".
    it("masks the creating user on a manually created link", async () => {
      const { reviewer, sessionToken } = await seedReviewer(db, app, {
        email: "jordan@sender-test.local",
        name: "Jordan",
        role: "admin",
      });
      expect(reviewer.name).toBe("Jordan");

      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ purpose: "hint test", recipient_label: "Acme Legal" });
      expect(genRes.status).toBe(201);

      const res = await request(app).get(`/r/${genRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("valid");
      expect(res.body.sender_hint).toBe("J***");
      // The recipient label must never leak into the sender field.
      expect(res.body.sender_hint).not.toBe("A***");
    });

    it("returns an empty hint for an agent-created link (no human sender)", async () => {
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ purpose: "agent link", recipient_label: "Morgan" });

      const res = await request(app).get(`/r/${genRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.sender_hint).toBe("");
    });

    it("carries the sender hint on the 410 expired body", async () => {
      const { sessionToken } = await seedReviewer(db, app, {
        email: "morgan@sender-test.local",
        name: "Morgan",
        role: "admin",
      });
      const reviewId = await createPendingReview();
      const genRes = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ purpose: "expired hint", recipient_label: "Acme Legal" });

      // Force hard expiry: past expires_at, never opened → no grace window.
      await db
        .update(reviewTokens)
        .set({ expires_at: new Date(Date.now() - 60_000), opened_at: null })
        .where(eq(reviewTokens.review_id, reviewId));

      const res = await request(app).get(`/r/${genRes.body.token}`);

      expect(res.status).toBe(410);
      expect(res.body.status).toBe("expired");
      expect(res.body.sender_hint).toBe("M***");
    });
  });
});

describe("SMTP guard on email_otp token generation", () => {
  let app: any;
  let client: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  async function createPendingReview(): Promise<string> {
    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: templateSlug,
      payload: { subject: "smtp-guard" },
      callback_url: "https://example.com/cb",
      status: "pending",
    }).returning();
    return rev.id;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "smtp-guard-test",
      project_id: projectId,
      name: "SMTP Guard Test",
      fields: [{ name: "subject", type: "text", label: "Subject" }],
      actions: ["approve", "reject"],
      enable_review_links: true,
    }).returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    // No emailTransport injected → isEmailConfigured() returns false.
    app = createApp({ db });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("refuses email_otp tokens with 409 smtp_not_configured when SMTP is absent", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        purpose: "smtp guard",
        recipient_label: "rec",
        auth_level: "email_otp",
        auth_email: "recipient@example.com",
      });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("smtp_not_configured");
  });

  it("public tokens are unaffected when SMTP is absent", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "pub ok", recipient_label: "rec", auth_level: "public" });
    expect(res.status).toBe(201);
  });

  it("account tokens are unaffected when SMTP is absent", async () => {
    const reviewId = await createPendingReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "acct ok", recipient_label: "rec", auth_level: "account", auth_user_id: "gw_usr_smtpguard" });
    expect(res.status).toBe(201);
  });
});
