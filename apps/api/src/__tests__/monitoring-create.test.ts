// HOTL monitoring gate — creation path integration tests.
// Verifies the 7 refusal codes, monitoring status at birth, template-default
// window, blocking-path unaffected, and distinct event emission.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable, chainRuns } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus, type EventData } from "../services/events";
import { createReviewCrudSlice } from "../services/reviews/crud";

describe("POST /api/v1/reviews — monitoring creation gate", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let eventBus: EventBus;

  // Template slugs
  const MON_SLUG = "mon-tpl";
  const PLAIN_SLUG = "plain-tpl";
  const AUTO_SLUG = "auto-tpl";
  const MON_TIMEOUT_SLUG = "mon-tpl-timeout";
  const CHAIN_SLUG = "chain-tpl";
  const CHAIN_STEP_SLUG = "chain-step-tpl";

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    // Seed step template for chain_config reference
    await db.insert(templates).values({
      id: generateId("template"),
      slug: CHAIN_STEP_SLUG,
      project_id: projectId,
      name: "Chain Step Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    // mon-tpl: allow_monitoring=true, no chain_config, auto_approve=false, no timeout default
    await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_SLUG,
      project_id: projectId,
      name: "Monitoring Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
    });

    // plain-tpl: allow_monitoring=false
    await db.insert(templates).values({
      id: generateId("template"),
      slug: PLAIN_SLUG,
      project_id: projectId,
      name: "Plain Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: false,
    });

    // auto-tpl: allow_monitoring=true, auto_approve=true
    await db.insert(templates).values({
      id: generateId("template"),
      slug: AUTO_SLUG,
      project_id: projectId,
      name: "Auto Approve Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: true,
    });

    // mon-tpl-timeout: allow_monitoring=true, timeout_seconds=600
    await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_TIMEOUT_SLUG,
      project_id: projectId,
      name: "Monitoring Template with Timeout",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
      timeout_seconds: 600,
    });

    // chain-tpl: has chain_config
    await db.insert(templates).values({
      id: generateId("template"),
      slug: CHAIN_SLUG,
      project_id: projectId,
      name: "Chain Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      chain_config: {
        version: "1.0",
        mode: "sequential",
        rejection_policy: "terminate",
        steps: [
          {
            id: "s1",
            template: CHAIN_STEP_SLUG,
            assignee: { kind: "user", email: "alice@example.com" },
          },
        ],
      },
    });

    eventBus = new EventBus();
    app = createApp({ db, eventBus });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  // Canonical monitoring body
  const MON_BODY = {
    template: MON_SLUG,
    payload: { msg: "digest" },
    oversight: "monitoring",
    irreversibility: "reversible",
    callback_url: "https://agent.example/cb",
    timeout: { seconds: 300 },
  };

  // ——————————————————————————————————————————
  // T1: Happy path
  // ——————————————————————————————————————————
  it("T1: happy path — 201, monitoring status, expires_at set, timeout_action IS NULL", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send(MON_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("monitoring");
    expect(res.body.oversight).toBe("monitoring");
    expect(res.body.expires_at).toBeTruthy();

    // Verify timeout_action IS NULL in the DB row
    const [row] = await db
      .select()
      .from(reviewsTable)
      .where(eq(reviewsTable.id, res.body.id))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.timeout_action).toBeNull();
  });

  // ——————————————————————————————————————————
  // T2: Refusal matrix
  // ——————————————————————————————————————————
  describe("T2: refusal matrix", () => {
    it("missing irreversibility → monitoring_requires_reversible", async () => {
      const { irreversibility: _, ...body } = MON_BODY;
      const res = await request(app).post("/api/v1/reviews").set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_requires_reversible");
    });

    it("irreversibility 'costly_reversible' → monitoring_requires_reversible", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, irreversibility: "costly_reversible" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_requires_reversible");
    });

    it("irreversibility 'irreversible' → monitoring_requires_reversible", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, irreversibility: "irreversible" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_requires_reversible");
    });

    it("template 'plain-tpl' → monitoring_not_enabled_for_template", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, template: PLAIN_SLUG });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_not_enabled_for_template");
    });

    it("template 'auto-tpl' → monitoring_conflicts_with_auto_approve", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, template: AUTO_SLUG });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_conflicts_with_auto_approve");
    });

    it("callback_url omitted → monitoring_requires_callback_url", async () => {
      const { callback_url: _, ...body } = MON_BODY;
      const res = await request(app).post("/api/v1/reviews").set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_requires_callback_url");
    });

    it("timeout omitted (template has no default) → monitoring_requires_timeout", async () => {
      const { timeout: _, ...body } = MON_BODY;
      const res = await request(app).post("/api/v1/reviews").set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_requires_timeout");
    });

    it("assignment_ladder supplied → monitoring_forbids_assignment_ladder", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({
          ...MON_BODY,
          assignment_ladder: [{ actor: "alice@example.com", trigger_after_seconds: 120 }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_forbids_assignment_ladder");
    });

    it("chain template → monitoring_not_supported_for_chains", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, template: CHAIN_SLUG });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_not_supported_for_chains");
    });

    it("chain refusal is side-effect-free: no chain_runs row spawned by the rejected POST", async () => {
      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, template: CHAIN_SLUG });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("monitoring_not_supported_for_chains");

      // The gate runs BEFORE the chain branch, so the refused request must
      // never reach ChainEngine.createRun. No other test in this file spawns
      // a chain, so the project-wide count must be exactly zero.
      const runs = await db
        .select()
        .from(chainRuns)
        .where(eq(chainRuns.project_id, projectId));
      expect(runs).toHaveLength(0);
    });
  });

  // ——————————————————————————————————————————
  // T3: Template default fills the window
  // ——————————————————————————————————————————
  it("T3: template timeout_seconds=600 default fills window when body.timeout omitted", async () => {
    const before = Date.now();
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: MON_TIMEOUT_SLUG,
        payload: { msg: "digest" },
        oversight: "monitoring",
        irreversibility: "reversible",
        callback_url: "https://agent.example/cb",
        // no timeout body — template supplies 600s default
      });

    expect(res.status).toBe(201);
    expect(res.body.expires_at).toBeTruthy();

    const expiresAt = new Date(res.body.expires_at).getTime();
    const expectedMin = before + 600 * 1000 - 2000; // 2s tolerance
    const expectedMax = before + 600 * 1000 + 2000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  // ——————————————————————————————————————————
  // T4: Blocking unaffected
  // ——————————————————————————————————————————
  it("T4: blocking creation against plain-tpl is unaffected — 201, status=pending", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: PLAIN_SLUG,
        payload: { msg: "blocking" },
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
  });

  it("T4b: explicit oversight 'blocking' behaves exactly like absent — 201, pending, review.created emitted", async () => {
    const created: EventData[] = [];
    const offCreated = eventBus.on("review.created", (e) => { created.push(e); });

    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: PLAIN_SLUG,
        payload: { msg: "explicit blocking" },
        oversight: "blocking",
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.oversight).toBe("blocking");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ review_id: res.body.id });

    offCreated();
  });

  // ——————————————————————————————————————————
  // T6: Service-seam invariant (independent of the route gate)
  // ——————————————————————————————————————————
  it("T6: service.create with oversight monitoring and no window throws monitoring_requires_timeout", async () => {
    // Pins the service-layer invariant directly: even a caller that bypasses
    // the route gate (or a template whose timeout default was removed between
    // the route's select and create()'s own select) cannot insert a
    // monitoring row with NULL expires_at — a permanent zombie otherwise.
    const service = createReviewCrudSlice(db);
    await expect(
      service.create(projectId, {
        template: MON_SLUG, // no timeout default on this template
        payload: { msg: "zombie attempt" },
        callback_url: "https://agent.example/cb",
        irreversibility: "reversible",
        oversight: "monitoring",
        // no timeout supplied
      }),
    ).rejects.toMatchObject({ code: "monitoring_requires_timeout" });
  });

  // ——————————————————————————————————————————
  // T5: Event emission
  // ——————————————————————————————————————————
  describe("T5: event emission", () => {
    it("monitoring creation emits review.monitoring_created and does NOT emit review.created or review.urgent", async () => {
      const monitoringCreated: EventData[] = [];
      const created: EventData[] = [];
      const urgent: EventData[] = [];

      const offMon = eventBus.on("review.monitoring_created", (e) => { monitoringCreated.push(e); });
      const offCreated = eventBus.on("review.created", (e) => { created.push(e); });
      const offUrgent = eventBus.on("review.urgent", (e) => { urgent.push(e); });

      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ ...MON_BODY, priority: "critical" });

      expect(res.status).toBe(201);
      expect(monitoringCreated).toHaveLength(1);
      expect(monitoringCreated[0]).toMatchObject({
        review_id: res.body.id,
        template: MON_SLUG,
        project_id: projectId,
      });
      // Countdown context rides on the creation event (review deep link
      // needs no refetch to render the veto-window timer).
      expect(monitoringCreated[0].expires_at).toBeTruthy();
      // No review.created and no review.urgent for monitoring (even with critical priority)
      expect(created).toHaveLength(0);
      expect(urgent).toHaveLength(0);

      offMon();
      offCreated();
      offUrgent();
    });

    it("blocking creation emits review.created (not review.monitoring_created)", async () => {
      const monitoringCreated: EventData[] = [];
      const created: EventData[] = [];

      const offMon = eventBus.on("review.monitoring_created", (e) => { monitoringCreated.push(e); });
      const offCreated = eventBus.on("review.created", (e) => { created.push(e); });

      const res = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ template: PLAIN_SLUG, payload: { msg: "blocking" } });

      expect(res.status).toBe(201);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ review_id: res.body.id });
      expect(monitoringCreated).toHaveLength(0);

      offMon();
      offCreated();
    });
  });
});
