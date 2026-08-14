// reviews.decided_by is contracted to hold a human-readable decider (see the
// "Legacy SDK contract" note in services/reviews/actions.ts). Both recipient
// decide paths wrote the raw token id instead, so History printed
// `gw_tok_...` where a person belongs — the same defect class as an assignee
// id rendered as a person.
//
// The tier matters, not just the value. email_otp proves control of an
// address; account proves it by sign-in and carries its identity on the
// SESSION, with verifiedEmail left null (gateRecipientAuth) — so reading only
// the email would stamp the strongest tier as unverified. A public link
// proves nothing and legitimately falls back to the label the SHARER typed,
// which must therefore be marked unverified rather than presented as a name.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { reviewTokens, reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";
import {
  RECIPIENT_SESSION_AUDIENCE,
  RECIPIENT_SESSION_ISSUER,
  RECIPIENT_SESSION_TTL_SECONDS,
  recipientSessionCookieName,
} from "../services/token-recipient-session";

describe("decided_by names a person, and says whether it was confirmed", () => {
  let app: any;
  let client: any;
  let db: any;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  const SHARER_TYPED_LABEL = "Acme Reviewer";

  async function makeToken(opts: {
    tier: "public" | "email_otp" | "account";
    auth_email?: string;
    auth_user_id?: string;
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
    await db.insert(reviewTokens).values({
      id: tokenId,
      token_hash: createHash("sha256").update(rawToken).digest("hex"),
      review_id: rev.id,
      project_id: projectId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      purpose: "test",
      recipient_label: SHARER_TYPED_LABEL,
      auth_level: opts.tier,
      auth_email: opts.auth_email ?? null,
      auth_user_id: opts.auth_user_id ?? null,
      created_by_kind: "manual",
      created_by_id: "test",
      is_preview: false,
    });
    return { tokenId, rawToken, reviewId: rev.id };
  }

  function emailOtpCookie(tokenId: string, email: string): string {
    const sessionJwt = jwt.sign({ email }, config.jwtSecret, {
      algorithm: "HS256",
      audience: RECIPIENT_SESSION_AUDIENCE,
      issuer: RECIPIENT_SESSION_ISSUER,
      subject: tokenId,
      expiresIn: RECIPIENT_SESSION_TTL_SECONDS,
    });
    return `${recipientSessionCookieName(tokenId)}=${sessionJwt}`;
  }

  async function readReview(reviewId: string) {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, reviewId)).limit(1);
    return row;
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
        slug: "decided-by-test",
        project_id: projectId,
        name: "Decided By Test",
        fields: [{ name: "subject", type: "text", label: "Subject" }],
        actions: [
          {
            id: "approve",
            kind: "decision",
            label: "Approve",
            decision_value: "approved",
            enabled_for_status: ["pending", "awaiting_external"],
          },
        ],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db, emailTransport: { send: async () => ({ messageId: "t" }) } as any });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("records the verified address, not the token id, for an email_otp decision", async () => {
    const { tokenId, rawToken, reviewId } = await makeToken({
      tier: "email_otp",
      auth_email: "dana@example.com",
    });

    const res = await request(app)
      .post(`/r/${rawToken}/action`)
      .set("Cookie", emailOtpCookie(tokenId, "dana@example.com"))
      .send({ action_id: "approve" });
    expect(res.status).toBe(200);

    const review = await readReview(reviewId);
    expect(review.decided_by).toBe("dana@example.com");
    expect(review.decided_by).not.toMatch(/^gw_tok_/);
    expect(review.decided_by_verified).toBe(true);
  });

  it("falls back to the sharer's label for a public link, and marks it unverified", async () => {
    const { rawToken, reviewId } = await makeToken({ tier: "public" });

    const res = await request(app)
      .post(`/r/${rawToken}/action`)
      .send({ action_id: "approve" });
    expect(res.status).toBe(200);

    const review = await readReview(reviewId);
    expect(review.decided_by).toBe(SHARER_TYPED_LABEL);
    expect(review.decided_by).not.toMatch(/^gw_tok_/);
    // The whole point: this name is free text the sharer typed, so the record
    // must not present it as a confirmed identity.
    expect(review.decided_by_verified).toBe(false);
  });

  it("keeps the token id on last_action_by, where being unambiguous matters", async () => {
    const { tokenId, rawToken, reviewId } = await makeToken({
      tier: "email_otp",
      auth_email: "forensic@example.com",
    });

    await request(app)
      .post(`/r/${rawToken}/action`)
      .set("Cookie", emailOtpCookie(tokenId, "forensic@example.com"))
      .send({ action_id: "approve" })
      .expect(200);

    const review = await readReview(reviewId);
    // Readable identity for humans, and the decision is still traceable to
    // the exact token row via review_tokens.
    expect(review.decided_by).toBe("forensic@example.com");
    const [tokenRow] = await db
      .select()
      .from(reviewTokens)
      .where(eq(reviewTokens.id, tokenId))
      .limit(1);
    expect(tokenRow.used_at).not.toBeNull();
    expect(tokenRow.decided_by_email).toBe("forensic@example.com");
  });

  it("marks an in-app reviewer decision verified", async () => {
    const { reviewer, sessionToken } = await seedReviewer(db, app, {
      email: "staff@example.com",
      role: "admin",
    });
    expect(reviewer).toBeTruthy();

    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_id: templateId,
        template_slug: templateSlug,
        payload: { subject: "in app" },
        status: "pending",
      })
      .returning();

    const res = await request(app)
      .post(`/api/v1/reviews/${rev.id}/action`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ action_id: "approve" });
    expect(res.status).toBe(200);

    const review = await readReview(rev.id);
    expect(review.decided_by_verified).toBe(true);
    expect(review.decided_by).not.toMatch(/^gw_tok_/);
  });

  it("exposes the verification claim on the review API", async () => {
    const { rawToken, reviewId } = await makeToken({ tier: "public" });
    await request(app).post(`/r/${rawToken}/action`).send({ action_id: "approve" }).expect(200);

    const seed = await seedReviewer(db, app, { email: "reader@example.com", role: "admin" });
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set("Authorization", `Bearer ${seed.sessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.decided_by).toBe(SHARER_TYPED_LABEL);
    expect(res.body.decided_by_verified).toBe(false);
  });
});
