import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("E2E Review Lifecycle", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Create templates for E2E tests
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "email-review",
      project_id: seed.project.id,
      name: "Email Review",
      fields: [
        { name: "subject", type: "text", label: "Subject", editable: true },
        { name: "body", type: "markdown", label: "Body", editable: true },
        { name: "recipient", type: "text", label: "To", readonly: true },
      ],
      actions: ["approve", "reject", "edit"],
    });

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "deploy-gate",
      project_id: seed.project.id,
      name: "Deploy Gate",
      fields: [
        { name: "service", type: "text", label: "Service" },
        { name: "version", type: "text", label: "Version" },
      ],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  describe("Happy path: Create -> Decide -> Feedback", () => {
    let reviewId: string;

    it("1. Agent creates a review", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "email-review",
          payload: {
            subject: "Meeting follow-up",
            body: "Hi team, here are the action items...",
            recipient: "team@company.com",
          },
          callback_url: "https://agent.example.com/callback",
          priority: "high",
          metadata: { thread_id: "thread_abc", run_id: "run_123" },
        });

      expect(res.status).toBe(201);
      expect(res.body.object).toBe("review");
      expect(res.body.status).toBe("pending");
      expect(res.body.priority).toBe("high");
      expect(res.body.metadata).toEqual({ thread_id: "thread_abc", run_id: "run_123" });
      reviewId = res.body.id;
    });

    it("2. Review appears in list", async () => {
      const res = await request(app)
        .get("/api/v1/reviews?status=pending")
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("list");
      const found = res.body.items.find((r: any) => r.id === reviewId);
      expect(found).toBeDefined();
      expect(found.template_slug).toBe("email-review");
    });

    it("3. Get review details", async () => {
      const res = await request(app)
        .get(`/api/v1/reviews/${reviewId}`)
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("review");
      expect(res.body.payload.subject).toBe("Meeting follow-up");
      expect(res.body.payload.recipient).toBe("team@company.com");
    });

    it("4. Reviewer approves with edits", async () => {
      const res = await request(app)
        .post(`/api/v1/reviews/${reviewId}/decide`)
        .set(auth())
        .send({
          decision: "edited",
          edited_payload: {
            subject: "Meeting Follow-Up - Action Items",
            body: "Hi team,\n\nHere are the action items from today's meeting:\n1. ...",
            recipient: "team@company.com",
          },
          feedback: "Improved subject line and formatting",
          reviewer: "alice@company.com",
        });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("review");
      expect(res.body.status).toBe("decided");
      expect(res.body.decision).toBe("edited");
      expect(res.body.decided_by).toBe("alice@company.com");
    });

    it("5. Decided review no longer in pending list", async () => {
      const res = await request(app)
        .get("/api/v1/reviews?status=pending")
        .set(auth());

      const found = res.body.items.find((r: any) => r.id === reviewId);
      expect(found).toBeUndefined();
    });

    it("6. Feedback is queryable", async () => {
      const res = await request(app)
        .get("/api/v1/feedback?template=email-review&outcome=edited")
        .set(auth());

      expect(res.status).toBe(200);
      const found = res.body.items.find((f: any) => f.review_id === reviewId);
      expect(found).toBeDefined();
      expect(found.decision).toBe("edited");
      expect(found.original_payload.subject).toBe("Meeting follow-up");
    });
  });

  describe("Reject path", () => {
    it("Creates review and rejects it", async () => {
      const create = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "deploy-gate",
          payload: { service: "payments", version: "2.0.0-beta" },
          callback_url: "https://agent.example.com/callback",
        });

      expect(create.status).toBe(201);

      const decide = await request(app)
        .post(`/api/v1/reviews/${create.body.id}/decide`)
        .set(auth())
        .send({
          decision: "rejected",
          feedback: "Beta version not approved for production",
          reviewer: "bob@company.com",
        });

      expect(decide.status).toBe(200);
      expect(decide.body.decision).toBe("rejected");
      expect(decide.body.feedback).toBe("Beta version not approved for production");
    });
  });

  describe("Retry path", () => {
    it("Creates review -> retry with feedback -> update version -> decide", async () => {
      // 1. Create
      const create = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "email-review",
          payload: { subject: "Q1 Report", body: "Draft...", recipient: "ceo@company.com" },
          callback_url: "https://agent.example.com/callback",
        });

      expect(create.status).toBe(201);
      const id = create.body.id;

      // 2. Retry
      const retry = await request(app)
        .post(`/api/v1/reviews/${id}/retry`)
        .set(auth())
        .send({
          feedback: "Too brief. Include revenue numbers.",
          prompt_edit: "Write a detailed Q1 report with revenue, growth, and projections",
        });

      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe("awaiting_iteration");

      // 3. Agent submits updated version
      const update = await request(app)
        .put(`/api/v1/reviews/${id}`)
        .set(auth())
        .send({
          payload: {
            subject: "Q1 2026 Report - Revenue & Growth",
            body: "Revenue: $4.2M (+23% YoY)...",
            recipient: "ceo@company.com",
          },
          version: 2,
        });

      expect(update.status).toBe(200);
      expect(update.body.current_version).toBe(2);

      // 4. Approve updated version
      const decide = await request(app)
        .post(`/api/v1/reviews/${id}/decide`)
        .set(auth())
        .send({
          decision: "approved",
          reviewer: "alice@company.com",
        });

      expect(decide.status).toBe(200);
      expect(decide.body.decision).toBe("approved");
    });
  });

  describe("Error cases", () => {
    it("rejects review with unknown template", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "nonexistent-template",
          payload: { data: "test" },
          callback_url: "https://example.com/webhook",
        });

      expect(res.status).toBe(400);
    });

    it("rejects review without auth", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .send({
          template: "email-review",
          payload: { subject: "test" },
          callback_url: "https://example.com/webhook",
        });

      expect(res.status).toBe(401);
    });

    it("rejects deciding same review twice", async () => {
      const create = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "email-review",
          payload: { subject: "double" },
          callback_url: "https://example.com/webhook",
        });

      await request(app)
        .post(`/api/v1/reviews/${create.body.id}/decide`)
        .set(auth())
        .send({ decision: "approved" });

      const second = await request(app)
        .post(`/api/v1/reviews/${create.body.id}/decide`)
        .set(auth())
        .send({ decision: "rejected" });

      expect(second.status).toBe(409);
    });

    it("returns 404 for nonexistent review", async () => {
      const res = await request(app)
        .get("/api/v1/reviews/gw_rev_nonexistent123456789")
        .set(auth());

      expect(res.status).toBe(404);
    });
  });

  describe("Stats reflect lifecycle", () => {
    it("stats endpoint returns aggregate data", async () => {
      const res = await request(app)
        .get("/api/v1/stats")
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0);
      expect(res.body.by_status).toBeDefined();
      expect(res.body.by_decision).toBeDefined();
    });
  });
});
