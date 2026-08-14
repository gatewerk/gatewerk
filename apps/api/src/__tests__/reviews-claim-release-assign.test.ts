// Task 2 — hold primitives: claim, release, assign, snooze.
// Tests run against in-memory PGlite; routes under test are
// POST /:id/claim   (requireScope reviews:claim)
// POST /:id/release (requireScope reviews:release)
// POST /:id/assign  (requireScope reviews:assign)
// POST /:id/snooze  (requireScope reviews:claim)

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviewers, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("hold primitives — claim / release / assign / snooze", () => {
  let app: any;
  let db: any;
  let apiKey: string;           // API key — has ALL_SCOPES (incl. reviews:assign)
  let reviewerToken: string;    // session as role=reviewer (no reviews:assign)
  let adminToken: string;       // session as role=admin (all scopes)
  let reviewerEmail: string;
  let adminEmail: string;

  async function createReview(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ template: "hold-tpl", payload: { task: "foo" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "hold-tpl",
      project_id: seed.project.id,
      name: "Hold Template",
      fields: [{ name: "task", type: "text", label: "Task" }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });

    reviewerEmail = "reviewer@hold.test";
    adminEmail = "admin@hold.test";

    await db.insert(reviewers).values({
      id: generateId("user"),
      email: reviewerEmail,
      name: "Reviewer",
      password_hash: await bcrypt.hash("pass123", 10),
      role: "reviewer",
    });
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: adminEmail,
      name: "Admin",
      password_hash: await bcrypt.hash("pass123", 10),
      role: "admin",
    });

    const rLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: reviewerEmail, password: "pass123" });
    reviewerToken = rLogin.body.token;

    const aLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: adminEmail, password: "pass123" });
    adminToken = aLogin.body.token;
  });

  // ── claim ──────────────────────────────────────────────────────────────────

  it("claim unheld review returns 200 with held_by = self", async () => {
    const id = await createReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("review");
    // held_by carries the non-null actor identity, symmetric with the audit
    // actor: session → reviewer:<email>.
    expect(res.body.held_by).toBe(`reviewer:${reviewerEmail}`);
    expect(res.body.held_at).toBeDefined();
  });

  it("claim already-held review (held by someone else) returns 409 review_already_held", async () => {
    const id = await createReview();
    // Reviewer claims first
    await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .expect(200);
    // Admin tries to claim without force → 409
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe("review_already_held");
  });

  it("force-claim as a reviewer (no reviews:assign) returns 403", async () => {
    const id = await createReview();
    // Admin claims first
    await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);
    // Reviewer tries force-claim → 403
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/claim?force=true`)
      .set({ Authorization: `Bearer ${reviewerToken}` });
    expect(res.status).toBe(403);
  });

  it("force-claim as admin returns 200 and overwrites hold", async () => {
    const id = await createReview();
    // Reviewer claims first
    await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .expect(200);
    // Admin force-claims
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/claim?force=true`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(200);
    expect(res.body.held_by).toBe(`reviewer:${adminEmail}`);
  });

  it("claim via API-key sets a NON-NULL held_by; second claim by a different actor returns 409", async () => {
    const id = await createReview();
    // First claim over API-key auth (non-session path). Seed key prefix is
    // gwk_test1 → actor agent:gwk_test1. This proves the soft-lock engages for
    // non-session callers (the null-held_by regression this guards against).
    const first = await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${apiKey}` });
    expect(first.status).toBe(200);
    expect(first.body.held_by).toBe("agent:gwk_test1");
    expect(first.body.held_by).not.toBeNull();
    // A different actor (session reviewer) claims without force → 409.
    const second = await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` });
    expect(second.status).toBe(409);
    expect(second.body.error?.code ?? second.body.code).toBe("review_already_held");
  });

  // ── release ────────────────────────────────────────────────────────────────

  it("release clears held_by", async () => {
    const id = await createReview();
    await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .expect(200);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/release`)
      .set({ Authorization: `Bearer ${reviewerToken}` });
    expect(res.status).toBe(200);
    expect(res.body.held_by).toBeNull();
    expect(res.body.held_at).toBeNull();
  });

  it("release by a non-holder non-admin session returns 403 and leaves the hold intact", async () => {
    // Reviewer A (the seeded reviewer session) claims.
    const id = await createReview();
    await request(app)
      .post(`/api/v1/reviews/${id}/claim`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .expect(200);

    // Reviewer B — a DIFFERENT non-admin session — tries to release.
    const bEmail = "reviewer-b@hold.test";
    await db.insert(reviewers).values({
      id: generateId("user"),
      email: bEmail,
      name: "Reviewer B",
      password_hash: await bcrypt.hash("pass123", 10),
      role: "reviewer",
    });
    const bLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: bEmail, password: "pass123" });
    const bToken = bLogin.body.token;

    const res = await request(app)
      .post(`/api/v1/reviews/${id}/release`)
      .set({ Authorization: `Bearer ${bToken}` });
    expect(res.status).toBe(403);

    // Hold must be unchanged — still held by A.
    const after = await request(app)
      .get(`/api/v1/reviews/${id}`)
      .set({ Authorization: `Bearer ${apiKey}` });
    expect(after.body.held_by).toBe(`reviewer:${reviewerEmail}`);
  });

  // ── assign ─────────────────────────────────────────────────────────────────

  it("assign sets assignee; when hold:true held_by is normalized to the reviewer:<email> identity", async () => {
    const id = await createReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/assign`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ assignee: reviewerEmail, hold: true });
    expect(res.status).toBe(200);
    expect(res.body.assignee).toBe(reviewerEmail);
    // Stored in the SAME identity format the assignee presents with on release.
    expect(res.body.held_by).toBe(`reviewer:${reviewerEmail}`);
  });

  it("assignee can self-release an assign-created hold (200, held_by cleared)", async () => {
    const id = await createReview();
    // Admin assigns to reviewer (the seeded session user) WITH hold.
    const assigned = await request(app)
      .post(`/api/v1/reviews/${id}/assign`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ assignee: reviewerEmail, hold: true });
    expect(assigned.status).toBe(200);
    expect(assigned.body.held_by).toBe(`reviewer:${reviewerEmail}`);
    // The assignee (session reviewer) releases their own hold.
    const released = await request(app)
      .post(`/api/v1/reviews/${id}/release`)
      .set({ Authorization: `Bearer ${reviewerToken}` });
    expect(released.status).toBe(200);
    expect(released.body.held_by).toBeNull();
    expect(released.body.held_at).toBeNull();
  });

  it("assign sets assignee only (hold:false) without touching held_by", async () => {
    const id = await createReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/assign`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ assignee: reviewerEmail });
    expect(res.status).toBe(200);
    expect(res.body.assignee).toBe(reviewerEmail);
    // held_by should still be null (review was never claimed)
    expect(res.body.held_by).toBeNull();
  });

  // ── snooze ─────────────────────────────────────────────────────────────────

  it("snooze sets snoozed_until to the exact timestamp sent", async () => {
    const id = await createReview();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/snooze`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .send({ until });
    expect(res.status).toBe(200);
    expect(res.body.snoozed_until).toBeTruthy();
    // The echoed value must round-trip to the same instant we sent.
    expect(new Date(res.body.snoozed_until).getTime()).toBe(new Date(until).getTime());
  });

  it("snooze with until:null cancels (clears snoozed_until)", async () => {
    const id = await createReview();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await request(app)
      .post(`/api/v1/reviews/${id}/snooze`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .send({ until })
      .expect(200);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/snooze`)
      .set({ Authorization: `Bearer ${reviewerToken}` })
      .send({ until: null });
    expect(res.status).toBe(200);
    expect(res.body.snoozed_until).toBeNull();
  });
});
