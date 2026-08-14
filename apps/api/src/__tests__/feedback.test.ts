import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";

describe("Feedback API", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    app = createApp({ db });

    const auth = { Authorization: `Bearer ${apiKey}` };

    // Create two templates
    await request(app)
      .post("/api/v1/templates")
      .set(auth)
      // `title` is declared AND marked editable because review 3 below decides
      // with edited_payload: {title}. Server-side editable enforcement (S1)
      // refuses a changed value on a field the template does not mark
      // editable, and refuses undeclared keys outright — and `title` was
      // previously not declared at all, so this fixture only ever passed
      // because nothing checked. This test is about feedback aggregation, so
      // the fixture is made coherent rather than the gate relaxed.
      .send({ slug: "feedback-tpl", name: "Feedback Template", fields: [{ name: "content", type: "text", label: "Content" }, { name: "title", type: "text", label: "Title", editable: true }], actions: ["approve", "reject"] });

    await request(app)
      .post("/api/v1/templates")
      .set(auth)
      .send({ slug: "other-tpl", name: "Other Template", fields: [{ name: "content", type: "text", label: "Content" }], actions: ["approve", "reject"] });

    // Create review 1 and approve it
    const review1 = await request(app)
      .post("/api/v1/reviews")
      .set(auth)
      .send({ template: "feedback-tpl", payload: { title: "Test 1" }, callback_url: "https://example.com/cb" });

    await request(app)
      .post(`/api/v1/reviews/${review1.body.id}/decide`)
      .set(auth)
      .send({ decision: "approved", feedback: "looks good" });

    // Create review 2 with different template and reject it
    const review2 = await request(app)
      .post("/api/v1/reviews")
      .set(auth)
      .send({ template: "other-tpl", payload: { title: "Test 2" }, callback_url: "https://example.com/cb" });

    await request(app)
      .post(`/api/v1/reviews/${review2.body.id}/decide`)
      .set(auth)
      .send({ decision: "rejected", feedback: "needs work" });

    // Create review 3 with edited_payload
    const review3 = await request(app)
      .post("/api/v1/reviews")
      .set(auth)
      .send({ template: "feedback-tpl", payload: { title: "Test 3" }, callback_url: "https://example.com/cb" });

    await request(app)
      .post(`/api/v1/reviews/${review3.body.id}/decide`)
      .set(auth)
      .send({ decision: "edited", edited_payload: { title: "Test 3 edited" } });

    // Create a pending review (should NOT appear in feedback)
    await request(app)
      .post("/api/v1/reviews")
      .set(auth)
      .send({ template: "feedback-tpl", payload: { title: "Pending" }, callback_url: "https://example.com/cb" });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("returns feedback items from decided reviews", async () => {
    const res = await request(app)
      .get("/api/v1/feedback")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);
    expect(res.body.items.length).toBe(3);
    expect(typeof res.body.total).toBe("number");
    expect(typeof res.body.has_more).toBe("boolean");
  });

  it("filters by template query param", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?template=feedback-tpl")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    res.body.items.forEach((item: any) => {
      expect(item.template).toBe("feedback-tpl");
    });
  });

  it("filters by outcome query param (decision type)", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?outcome=rejected")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].decision).toBe("rejected");
  });

  it("returns items matching FeedbackItem schema", async () => {
    const res = await request(app)
      .get("/api/v1/feedback")
      .set(auth());
    expect(res.status).toBe(200);

    for (const item of res.body.items) {
      expect(item.review_id).toBeDefined();
      expect(typeof item.review_id).toBe("string");
      expect(item.template).toBeDefined();
      expect(typeof item.template).toBe("string");
      expect(item.decision).toBeDefined();
      expect(["approved", "rejected", "edited", "retried", "expired"]).toContain(item.decision);
      expect(item.original_payload).toBeDefined();
      expect(typeof item.original_payload).toBe("object");
      expect(item.decided_at).toBeDefined();
      expect(typeof item.decided_at).toBe("string");
    }

    // Check that edited_payload is present only when it was provided
    const editedItem = res.body.items.find((i: any) => i.decision === "edited");
    expect(editedItem.edited_payload).toBeDefined();
    expect(editedItem.edited_payload.title).toBe("Test 3 edited");

    // Check that feedback is present when it was provided
    const approvedItem = res.body.items.find((i: any) => i.decision === "approved");
    expect(approvedItem.feedback).toBe("looks good");
  });

  it("returns empty array when no decided reviews exist", async () => {
    // Use a template filter that has no decided reviews matching
    const res = await request(app)
      .get("/api/v1/feedback?template=nonexistent-template")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.has_more).toBe(false);
  });

  it("supports pagination with limit and offset", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?limit=1&offset=0")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.has_more).toBe(true);

    const res2 = await request(app)
      .get("/api/v1/feedback?limit=1&offset=1")
      .set(auth());
    expect(res2.status).toBe(200);
    expect(res2.body.items.length).toBe(1);
    // Different item from first page
    expect(res2.body.items[0].review_id).not.toBe(res.body.items[0].review_id);
  });

  it("combines template and outcome filters", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?template=feedback-tpl&outcome=approved")
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].decision).toBe("approved");
    expect(res.body.items[0].template).toBe("feedback-tpl");
  });
});
