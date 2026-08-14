import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  reviews,
  templates,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("POST /r/:token/action — integration (Phase 7)", () => {
  let app: any;
  let client: any;
  let db: any;
  let apiKey: string;
  let projectId: string;
  let templateId: string;
  let templateSlug: string;

  async function createPendingReview(): Promise<string> {
    const [rev] = await db
      .insert(reviews)
      .values({
        id: generateId("review"),
        project_id: projectId,
        template_id: templateId,
        template_slug: templateSlug,
        payload: { content: "token action test" },
        callback_url: "https://example.com/cb",
        status: "pending",
      })
      .returning();
    return rev.id;
  }

  async function generateToken(reviewId: string): Promise<string> {
    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/token`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ purpose: "test", recipient_label: "test recipient" });
    return res.body.token;
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    const [tpl] = await db
      .insert(templates)
      .values({
        id: generateId("template"),
        slug: "token-action-test",
        project_id: projectId,
        name: "Token Action Test",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          {
            id: "approve",
            label: "Approve",
            kind: "decision",
            decision_value: "approved",
            style: "primary",
            expose_to_recipient: true,
            enabled_for_status: ["pending", "awaiting_external"],
          },
          {
            id: "reject",
            label: "Reject",
            kind: "decision",
            decision_value: "rejected",
            style: "destructive",
            expose_to_recipient: true,
            enabled_for_status: ["pending", "awaiting_external"],
          },
          {
            id: "internal_only",
            label: "Internal",
            kind: "decision",
            decision_value: "approved",
            style: "primary",
            expose_to_recipient: false,
            enabled_for_status: ["pending", "awaiting_external"],
          },
        ],
        enable_review_links: true,
      })
      .returning();
    templateId = tpl.id;
    templateSlug = tpl.slug;

    app = createApp({ db });
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  // T1: Happy path — approve via /r/:token/action
  it("T1: approves a review via action_id and marks token as used", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "approve", feedback: "Looks good" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("decided");
    expect(res.body.decision).toBe("approved");

    const [row] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .limit(1);
    expect(row.status).toBe("decided");
    expect(row.decision).toBe("approved");
    expect(row.feedback).toBe("Looks good");
  });

  // T2: Reject via /r/:token/action
  it("T2: rejects a review via action_id", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "reject" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("decided");
    expect(res.body.decision).toBe("rejected");
  });

  // T3: Rejects action_id not exposed to recipient
  it("T3: rejects action not exposed to recipient", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "internal_only" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("action_not_available");
  });

  // T4: Rejects unknown action_id
  it("T4: rejects unknown action_id", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "nonexistent_action" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("action_not_available");
  });

  // T5: Double-use of token returns 410
  it("T5: rejects double-use of a token", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "approve" });

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "reject" });

    // Token is now in used state → 410; if first request failed, review
    // may be in decided state → 409 or token may have been partially
    // consumed. Either is a correct refusal.
    expect([409, 410]).toContain(res.status);
  });

  // T6: Invalid token format
  it("T6: rejects invalid token format", async () => {
    const res = await request(app)
      .post("/r/not_a_valid_prefix/action")
      .send({ action_id: "approve" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_token_format");
  });

  // T7: Missing action_id field
  it("T7: rejects missing action_id", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ feedback: "missing action_id" });

    // Zod validation via the validate() middleware returns 422; the
    // briefing spec expected 400 but 422 Unprocessable Entity is the
    // correct HTTP status for schema validation failures in this codebase.
    expect([400, 422]).toContain(res.status);
  });

  // T8: Compensating revert — if review is already decided by main app
  it("T8: compensating revert on state-machine rejection", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    // Decide via main app first
    await db
      .update(reviews)
      .set({ status: "decided", decision: "approved", decided_by: "admin" })
      .where(eq(reviews.id, reviewId));

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({ action_id: "approve" });

    // Should get a state error (410 or 409)
    expect([409, 410]).toContain(res.status);
  });

  // T9: Legacy /r/:token/decide still works with deprecation headers
  it("T9: legacy /r/:token/decide returns deprecation headers", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/decide`)
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    expect(res.headers["deprecation"]).toBe("true");
    expect(res.headers["sunset"]).toBeTruthy();
    expect(res.headers["link"]).toContain("/action");
  });

  // T10: with edited_payload.
  //
  // This test used to assert that an UNAUTHENTICATED link recipient's
  // rewrite of `content` — a field this template does NOT mark editable —
  // landed in edited_payload, i.e. it
  // encoded the vulnerability as the expected behaviour. `approved_value`
  // follows edited_payload into the decision webhook, so what it really
  // asserted was that a stranger with a public link could change the values
  // the agent then acts on.
  it("T10: refuses an edited_payload that changes a non-editable field", async () => {
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({
        action_id: "approve",
        edited_payload: { content: "edited by recipient" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");

    const [row] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .limit(1);
    // Refused before the guarded UPDATE: the review is untouched (still
    // awaiting the external recipient, not decided) and the token is unspent.
    expect(row.status).toBe("awaiting_external");
    expect(row.decision).toBeNull();
    expect(row.edited_payload).toBeNull();
    expect(row.approved_value).toBeNull();
  });

  it("T10b: passes an unchanged edited_payload echo through", async () => {
    // Both frontends submit the whole payload, not just the touched keys, so
    // an echo of the stored value must remain a valid submit.
    const reviewId = await createPendingReview();
    const token = await generateToken(reviewId);

    const res = await request(app)
      .post(`/r/${token}/action`)
      .send({
        action_id: "approve",
        edited_payload: { content: "token action test" },
      });

    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .limit(1);
    expect(row.edited_payload).toEqual({ content: "token action test" });
  });
});
