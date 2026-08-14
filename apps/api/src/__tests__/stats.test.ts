import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("Stats Endpoint", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Create two templates
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "stats-template-a",
      project_id: seed.project.id,
      name: "Stats Template A",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "stats-template-b",
      project_id: seed.project.id,
      name: "Stats Template B",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });

    const auth = () => ({ Authorization: `Bearer ${apiKey}` });

    // Create 4 reviews (3 with template-a, 1 with template-b)
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          template: "stats-template-a",
          payload: { content: `Review A-${i}` },
          callback_url: "https://example.com/cb",
        });
    }

    await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "stats-template-b",
        payload: { content: "Review B-0" },
        callback_url: "https://example.com/cb",
      });

    // Decide 2 reviews (approve 1, reject 1)
    const listRes = await request(app)
      .get("/api/v1/reviews")
      .set(auth());

    const pendingReviews = listRes.body.items;

    // Approve first review
    await request(app)
      .post(`/api/v1/reviews/${pendingReviews[0].id}/decide`)
      .set(auth())
      .send({ decision: "approved", reviewer: "tester@example.com" });

    // Reject second review
    await request(app)
      .post(`/api/v1/reviews/${pendingReviews[1].id}/decide`)
      .set(auth())
      .send({ decision: "rejected", reviewer: "tester@example.com" });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("returns correct total count", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it("returns by_status breakdown", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.by_status).toBeDefined();
    expect(res.body.by_status.pending).toBe(2);
    expect(res.body.by_status.decided).toBe(2);
  });

  it("returns by_decision breakdown", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.by_decision).toBeDefined();
    expect(res.body.by_decision.approved).toBe(1);
    expect(res.body.by_decision.rejected).toBe(1);
  });

  it("returns avg_review_time_ms greater than or equal to 0", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(typeof res.body.avg_review_time_ms).toBe("number");
    expect(res.body.avg_review_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns by_template array with correct counts", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.by_template)).toBe(true);
    expect(res.body.by_template.length).toBe(2);

    const templateA = res.body.by_template.find(
      (t: any) => t.template_slug === "stats-template-a"
    );
    const templateB = res.body.by_template.find(
      (t: any) => t.template_slug === "stats-template-b"
    );
    expect(templateA).toBeDefined();
    expect(templateA.count).toBe(3);
    expect(templateB).toBeDefined();
    expect(templateB.count).toBe(1);
  });

  it("returns reviews_per_day array", async () => {
    const res = await request(app).get("/api/v1/stats").set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reviews_per_day)).toBe(true);
    expect(res.body.reviews_per_day.length).toBeGreaterThan(0);

    // All reviews were created today, so there should be one entry
    const today = new Date().toISOString().split("T")[0];
    const todayEntry = res.body.reviews_per_day.find(
      (d: any) => d.date === today
    );
    expect(todayEntry).toBeDefined();
    expect(todayEntry.count).toBe(4);
  });
});
