// POST /api/v1/reviews/:id/action integration coverage — final spec §7.3
// scenarios from Phase 3 closure (commit 33-storage-normalization). The
// pure-fn dispatcher is unit-tested by actions-service.test.ts; this suite
// exercises the route, the executeReviewAction pipeline, the dispatcher's
// dual-fire path, and the legacy /cancel-request alias against a real DB.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { templates, reviews, apiKeys } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createHash } from "crypto";

describe("POST /api/v1/reviews/:id/action — integration (spec §7.3)", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let templateId: string;
  let sessionToken: string;
  let apiKey: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "action-route-test",
      project_id: projectId,
      name: "Action Route Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });

    const reviewerSeed = await seedReviewer(db, app, {
      email: "alice@example.com",
      role: "admin",
    });
    sessionToken = reviewerSeed.sessionToken;
  });

  const sessionAuth = () => ({ Authorization: `Bearer ${sessionToken}` });

  // Helper: seed a fresh review and return its id. Each test gets an
  // isolated review so race tests don't leak state.
  async function seedReview(opts: { status?: string } = {}): Promise<string> {
    const id = generateId("review");
    await db.insert(reviews).values({
      id,
      project_id: projectId,
      template_id: templateId,
      template_slug: "action-route-test",
      payload: { content: "race test payload" },
      status: opts.status ?? "pending",
      current_version: 1,
    });
    return id;
  }

  describe("S9 — race on simultaneous identical decision actions", () => {
    it("two concurrent approve calls with same expectedVersion → exactly one wins, one 409", async () => {
      const reviewId = await seedReview();

      const [a, b] = await Promise.all([
        request(app)
          .post(`/api/v1/reviews/${reviewId}/action`)
          .set(sessionAuth())
          .send({ action_id: "approve", version: 1 }),
        request(app)
          .post(`/api/v1/reviews/${reviewId}/action`)
          .set(sessionAuth())
          .send({ action_id: "approve", version: 1 }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const winner = a.status === 200 ? a : b;
      expect(winner.body.status).toBe("decided");
      expect(winner.body.decision).toBe("approved");
    });
  });

  describe("S10 — race on simultaneous different decision actions", () => {
    it("approve + reject concurrent → exactly one wins, one 409 with version_mismatch / review_already_decided", async () => {
      const reviewId = await seedReview();

      const [a, b] = await Promise.all([
        request(app)
          .post(`/api/v1/reviews/${reviewId}/action`)
          .set(sessionAuth())
          .send({ action_id: "approve" }),
        request(app)
          .post(`/api/v1/reviews/${reviewId}/action`)
          .set(sessionAuth())
          .send({ action_id: "reject", feedback: "Not aligned" }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      // Whoever wrote first wins; the other gets a specific conflict code.
      const loser = a.status === 409 ? a : b;
      const loserCode = loser.body?.error?.code;
      // Either review_already_decided (loser arrived after winner's UPDATE
      // committed) or version_mismatch (loser passed pre-emptive check but
      // lost the WHERE-clause race). Both are spec-correct outcomes.
      expect(["review_already_decided", "version_mismatch"]).toContain(loserCode);
    });
  });

  describe("S14 — cancel_iteration reverts awaiting_iteration → pending", () => {
    it("legacy /cancel-request alias on awaiting_iteration → pending + last_action_id=cancel_iteration", async () => {
      const reviewId = await seedReview({ status: "awaiting_iteration" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/cancel-request`)
        .set(sessionAuth());

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.last_action_id).toBe("cancel_iteration");
      expect(res.body.last_action_kind).toBe("side_effect");
    });

    it("/action endpoint with action_id=cancel_iteration → same outcome", async () => {
      const reviewId = await seedReview({ status: "awaiting_iteration" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set(sessionAuth())
        .send({ action_id: "cancel_iteration" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(res.body.last_action_id).toBe("cancel_iteration");
      expect(res.body.last_action_kind).toBe("side_effect");
    });

    it("cancel_iteration on a pending review → 400 action.status_not_allowed", async () => {
      const reviewId = await seedReview({ status: "pending" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set(sessionAuth())
        .send({ action_id: "cancel_iteration" });

      // cancel_iteration's enabled_for_status is ['awaiting_iteration'] only
      // (after Phase 3 closure). Invoking on a pending review fails the
      // status guard with action.status_not_allowed.
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("action.status_not_allowed");
    });
  });

  describe("api-key auth path (Phase 7)", () => {
    it("api-key caller gets 200 and review is decided", async () => {
      const reviewId = await seedReview({ status: "pending" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set("Authorization", `Bearer ${apiKey}`)
        .send({ action_id: "approve" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("decided");
      expect(res.body.decision).toBe("approved");
    });

    it("api-key without reviews:decide scope gets 403", async () => {
      // Seed a restricted api key with no reviews:decide scope
      const rawKey = "gwk_restricted1234567890ab";
      const keyHash = createHash("sha256").update(rawKey).digest("hex");
      await db.insert(apiKeys).values({
        id: generateId("api_key"),
        project_id: projectId,
        key_hash: keyHash,
        key_prefix: "gwk_restrict",
        label: "Restricted key",
        scopes: ["reviews:read"],
      });

      const reviewId = await seedReview({ status: "pending" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set("Authorization", `Bearer ${rawKey}`)
        .send({ action_id: "approve" });

      expect(res.status).toBe(403);
    });
  });

  describe("S14b — reject_from_iteration: terminal reject from awaiting_iteration", () => {
    it("reject_from_iteration on awaiting_iteration → 200, status=decided, decision=rejected, last_action_id=reject_from_iteration", async () => {
      const reviewId = await seedReview({ status: "awaiting_iteration" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set(sessionAuth())
        .send({ action_id: "reject_from_iteration" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("decided");
      expect(res.body.decision).toBe("rejected");
      expect(res.body.last_action_id).toBe("reject_from_iteration");
    });

    it("plain reject on awaiting_iteration → 409 review_awaiting_changes (guard unchanged)", async () => {
      const reviewId = await seedReview({ status: "awaiting_iteration" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set(sessionAuth())
        .send({ action_id: "reject", feedback: "Not acceptable" });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("review_awaiting_changes");
    });

    it("approve on awaiting_iteration → 409 review_awaiting_changes (guard unchanged)", async () => {
      const reviewId = await seedReview({ status: "awaiting_iteration" });

      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/action`)
        .set(sessionAuth())
        .send({ action_id: "approve" });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe("review_awaiting_changes");
    });
  });
});
