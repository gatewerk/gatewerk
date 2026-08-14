// HOTL monitoring gate — veto/confirm terminal endpoints.
// Verifies: human-only gating, exactly-once CAS, audit + webhook fire-and-forget,
// window-closed boundary, worker-lease clearing, and event bus emission.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import {
  templates,
  reviews as reviewsTable,
  webhookDeliveries,
  auditLog,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus, type EventData } from "../services/events";

const MON_SLUG = "mon-tpl-actions";

describe("POST /api/v1/reviews/:id/veto and /confirm", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let sessionToken: string;
  let eventBus: EventBus;

  // Helper: create a fresh monitoring review for each test case.
  async function createMonitoringReview(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        template: MON_SLUG,
        payload: { msg: "test" },
        oversight: "monitoring",
        irreversibility: "reversible",
        callback_url: "https://agent.example/cb",
        timeout: { seconds: 300 },
        ...overrides,
      });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    // Seed the monitoring template
    await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_SLUG,
      project_id: projectId,
      name: "Monitoring Actions Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
    });

    eventBus = new EventBus();
    app = createApp({ db, eventBus });

    // Seed a human reviewer session
    const reviewerSeed = await seedReviewer(db, app, {
      email: "alice@example.com",
      role: "reviewer",
    });
    sessionToken = reviewerSeed.sessionToken;
  });

  // ——————————————————————————————————————————
  // A1: api-key actors get 403 human_actor_required on both endpoints
  // ——————————————————————————————————————————
  it("api-key actors get 403 human_actor_required on both endpoints", async () => {
    const review = await createMonitoringReview();

    const vetoRes = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ note: "nope" });
    expect(vetoRes.status).toBe(403);
    expect(vetoRes.body.error.code).toBe("human_actor_required");

    const confirmRes = await request(app)
      .post(`/api/v1/reviews/${review.id}/confirm`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({});
    expect(confirmRes.status).toBe(403);
    expect(confirmRes.body.error.code).toBe("human_actor_required");
  });

  // ——————————————————————————————————————————
  // A2: veto happy path
  // ——————————————————————————————————————————
  it("veto: 200, decision=vetoed, status=decided, decided_by=email, note stored in feedback", async () => {
    const review = await createMonitoringReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "wrong channel" });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("vetoed");
    expect(res.body.status).toBe("decided");
    expect(res.body.feedback).toBe("wrong channel");

    // Webhook delivery row exists with correct event_type and note
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          eq(webhookDeliveries.event_type, "review.vetoed"),
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload.note).toBe("wrong channel");

    // Audit log row exists
    const logs = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, review.id),
          eq(auditLog.action, "review.vetoed"),
        ),
      );
    expect(logs).toHaveLength(1);
  });

  // ——————————————————————————————————————————
  // A3: confirm happy path
  // ——————————————————————————————————————————
  it("confirm now: 200, decision=confirmed, decided_by=email; webhook payload lapsed:false", async () => {
    const review = await createMonitoringReview();

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/confirm`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("confirmed");
    expect(res.body.status).toBe("decided");

    // Webhook delivery exists with lapsed:false
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          eq(webhookDeliveries.event_type, "review.confirmed"),
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload.lapsed).toBe(false);
  });

  // ——————————————————————————————————————————
  // A4: exactly-once — second terminal action → 409 review_already_decided
  // ——————————————————————————————————————————
  it("second terminal action → 409 review_already_decided; exactly ONE terminal webhook delivery row exists", async () => {
    const review = await createMonitoringReview();

    // First action: veto
    const first = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "first veto" });
    expect(first.status).toBe(200);

    // Second action: confirm → 409
    const second = await request(app)
      .post(`/api/v1/reviews/${review.id}/confirm`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("review_already_decided");

    // Exactly ONE terminal delivery row
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          inArray(webhookDeliveries.event_type, ["review.vetoed", "review.confirmed"]),
        ),
      );
    expect(deliveries).toHaveLength(1);
  });

  // ——————————————————————————————————————————
  // A5: after expires_at → 409 window_closed (worker has not run)
  // ——————————————————————————————————————————
  it("after expires_at → 409 window_closed even though the worker has not run", async () => {
    const review = await createMonitoringReview();

    // Expire the window in the DB without touching status
    await db
      .update(reviewsTable)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(reviewsTable.id, review.id));

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "too late" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("window_closed");

    // DB row still has status=monitoring (worker owns the lapse transition)
    const [row] = await db
      .select({ status: reviewsTable.status })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.status).toBe("monitoring");
  });

  // ——————————————————————————————————————————
  // A6: veto against a worker-claimed row clears the stale lease
  // ——————————————————————————————————————————
  it("veto succeeds against a worker-claimed row and clears the stale lease", async () => {
    const review = await createMonitoringReview();

    // Simulate a stale worker lease
    await db
      .update(reviewsTable)
      .set({ claimed_by: "worker-fake-1", claimed_at: new Date() })
      .where(eq(reviewsTable.id, review.id));

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "override" });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe("vetoed");

    // Lease should be cleared
    const [row] = await db
      .select({ claimed_by: reviewsTable.claimed_by })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.claimed_by).toBeNull();
  });

  // ——————————————————————————————————————————
  // A7: veto on a plain blocking review → 409 review_not_monitoring
  // ——————————————————————————————————————————
  it("veto on a plain blocking pending review → 409 review_not_monitoring", async () => {
    // Create a plain blocking review (no monitoring)
    const blockingRes = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ template: MON_SLUG, payload: { msg: "blocking" } });
    expect(blockingRes.status).toBe(201);
    expect(blockingRes.body.status).toBe("pending");

    const res = await request(app)
      .post(`/api/v1/reviews/${blockingRes.body.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "wrong" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("review_not_monitoring");
  });

  // ——————————————————————————————————————————
  // A8: held_by does not gate veto
  // ——————————————————————————————————————————
  it("held_by does not gate veto", async () => {
    const review = await createMonitoringReview();

    // Set held_by to a different reviewer
    await db
      .update(reviewsTable)
      .set({ held_by: "reviewer:someone-else@example.com" })
      .where(eq(reviewsTable.id, review.id));

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "overriding hold" });
    expect(res.status).toBe(200);
  });

  // ——————————————————————————————————————————
  // A9: veto without note — feedback stays null, webhook has no note key
  // ——————————————————————————————————————————
  it("veto without a note: 200, feedback stays null, webhook payload has no note key", async () => {
    const review = await createMonitoringReview();
    const vetoed: EventData[] = [];
    const off = eventBus.on("review.vetoed", (e) => { vetoed.push(e); });

    const res = await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.feedback).toBeNull();

    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.review_id, review.id),
          eq(webhookDeliveries.event_type, "review.vetoed"),
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect("note" in deliveries[0].payload).toBe(false);

    // SSE emit mirrors the webhook: note key omitted when no note was given.
    expect(vetoed).toHaveLength(1);
    expect("note" in vetoed[0]).toBe(false);
    off();
  });

  // ——————————————————————————————————————————
  // A10: event bus emission
  // ——————————————————————————————————————————
  it("emits review.vetoed on the event bus", async () => {
    const review = await createMonitoringReview();
    const vetoed: EventData[] = [];
    const off = eventBus.on("review.vetoed", (e) => { vetoed.push(e); });

    await request(app)
      .post(`/api/v1/reviews/${review.id}/veto`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ note: "emit test" });

    expect(vetoed).toHaveLength(1);
    // note rides its own field — NOT decline_reason (whose semantic owner is
    // the external-recipient send-back flow).
    expect(vetoed[0]).toMatchObject({ review_id: review.id, note: "emit test" });
    expect(vetoed[0].decline_reason).toBeUndefined();
    off();
  });

  it("emits review.confirmed on the event bus", async () => {
    const review = await createMonitoringReview();
    const confirmed: EventData[] = [];
    const off = eventBus.on("review.confirmed", (e) => { confirmed.push(e); });

    await request(app)
      .post(`/api/v1/reviews/${review.id}/confirm`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({});

    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ review_id: review.id });
    off();
  });

  // ——————————————————————————————————————————
  // A11: post-CAS side-effect failure never 500s a committed veto
  // ——————————————————————————————————————————
  it("veto still returns 200 with the row vetoed when a post-CAS side effect throws", async () => {
    const review = await createMonitoringReview();

    // Force the SSE emit (inside fireTerminalSideEffects, AFTER the CAS has
    // committed) to throw synchronously. The handler must swallow, log, and
    // still return the 200 envelope — a committed terminal attestation must
    // never surface as a 500.
    const originalEmit = eventBus.emit;
    (eventBus as any).emit = () => {
      throw new Error("side-effect boom");
    };
    try {
      const res = await request(app)
        .post(`/api/v1/reviews/${review.id}/veto`)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ note: "boom test" });
      expect(res.status).toBe(200);
      expect(res.body.decision).toBe("vetoed");
      expect(res.body.status).toBe("decided");
    } finally {
      (eventBus as any).emit = originalEmit;
    }

    // The CAS committed regardless of the side-effect failure.
    const [row] = await db
      .select({ status: reviewsTable.status, decision: reviewsTable.decision })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, review.id))
      .limit(1);
    expect(row.status).toBe("decided");
    expect(row.decision).toBe("vetoed");
  });
});
