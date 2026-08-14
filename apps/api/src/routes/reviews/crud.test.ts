/**
 * GET /api/v1/reviews/:id — notification_delivery_failed (Task 7).
 *
 * An undelivered "your turn" notification email is a correctness bug for an
 * oversight product: the assigned reviewer may never know the review exists.
 * This surfaces that as a single boolean on the review detail response —
 * true iff some notification for this review has an email_sends row with
 * bounced_at set.
 */
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../../app";
import { createTestDb, seedTestProject } from "../../__tests__/helpers/test-db";
import { templates, notifications, emailSends, reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("GET /api/v1/reviews/:id — notification_delivery_failed", () => {
  let app: any;
  let db: any;
  let apiKey: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // notifications.reviewer_id is now an FK to reviewers(id) (migration
    // 086) — seedNotification below reuses this one reviewer id for every
    // test in this file, so it only needs seeding once here.
    await db.insert(reviewers).values({
      id: "reviewer_bounce_test",
      email: "reviewer_bounce_test@example.com",
      name: "Bounce Test Reviewer",
      password_hash: "x",
    });

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "bounce-test-tpl",
      project_id: seed.project.id,
      name: "Bounce Test",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  async function createReview() {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "bounce-test-tpl", payload: { content: "x" } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  let dedupCounter = 0;

  async function seedNotification(reviewId: string, opts: { bouncedAt?: Date | null } = {}) {
    const notificationId = generateId("notification");
    dedupCounter += 1;
    await db.insert(notifications).values({
      id: notificationId,
      reviewer_id: "reviewer_bounce_test",
      review_id: reviewId,
      event: "review.assignment_changed",
      category: "assignment",
      title: "Your turn",
      dedup_key: `bounce-test-dedup-${dedupCounter}`,
    });
    await db.insert(emailSends).values({
      id: generateId("email_send"),
      message_id: `bounce-test-msg-${dedupCounter}`,
      organization_id: null,
      address: "reviewer@example.com",
      is_transactional: true,
      notification_id: notificationId,
      ...(opts.bouncedAt !== undefined ? { bounced_at: opts.bouncedAt } : {}),
    });
    return notificationId;
  }

  it("returns notification_delivery_failed: true when the notification's send bounced", async () => {
    const reviewId = await createReview();
    await seedNotification(reviewId, { bouncedAt: new Date() });

    const res = await request(app).get(`/api/v1/reviews/${reviewId}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.notification_delivery_failed).toBe(true);
  });

  it("returns notification_delivery_failed: false when the send did not bounce", async () => {
    const reviewId = await createReview();
    await seedNotification(reviewId, { bouncedAt: null });

    const res = await request(app).get(`/api/v1/reviews/${reviewId}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.notification_delivery_failed).toBe(false);
  });

  it("returns notification_delivery_failed: false (not an error) when there are no send rows at all", async () => {
    const reviewId = await createReview();
    // No notification, no email_sends row seeded at all.

    const res = await request(app).get(`/api/v1/reviews/${reviewId}`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.notification_delivery_failed).toBe(false);
  });

  // C-1: the chip that renders this flag (NotDeliveredChip, ReviewRow.tsx)
  // is fed exclusively by the LIST endpoint, never the detail endpoint above.
  // A fix that only touches GET /:id typechecks and passes every test above
  // while leaving the flag permanently undefined on every row the UI
  // actually renders. These two cases must hit GET /api/v1/reviews.
  it("list: returns notification_delivery_failed: true for a review whose notification bounced", async () => {
    const reviewId = await createReview();
    await seedNotification(reviewId, { bouncedAt: new Date() });

    const res = await request(app).get("/api/v1/reviews").set(auth());

    expect(res.status).toBe(200);
    const row = res.body.items.find((it: any) => it.id === reviewId);
    expect(row).toBeDefined();
    expect(row.notification_delivery_failed).toBe(true);
  });

  it("list: returns notification_delivery_failed: false for a review with no bounced notification", async () => {
    const reviewId = await createReview();
    await seedNotification(reviewId, { bouncedAt: null });

    const res = await request(app).get("/api/v1/reviews").set(auth());

    expect(res.status).toBe(200);
    const row = res.body.items.find((it: any) => it.id === reviewId);
    expect(row).toBeDefined();
    expect(row.notification_delivery_failed).toBe(false);
  });
});
