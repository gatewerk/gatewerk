import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus, type EventData } from "../services/events";

// Live-feed parity for POST /api/v1/chain-runs (R3 cleanup B1).
//
// POST /reviews already emits review.created on the chain-spawn branch (M12,
// see routes/reviews/crud.ts:142-154) so the SSE feed updates the inbox in
// real time. POST /chain-runs goes through the same ChainEngine.createRun
// codepath but historically did not emit — reviews materialized by direct
// chain creation were silent until the next inbox poll.
//
// This test wires a real EventBus into the app and verifies the emit
// (review.created, plus review.urgent for high/critical priority) fires
// with the expected shape after POST /chain-runs.

describe("POST /api/v1/chain-runs — live-feed parity", () => {
  let app: any;
  let apiKey: string;
  let eventBus: EventBus;
  let projectId: string;
  let templateSlug: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    templateSlug = "chain_livefeed_tpl";
    await db.insert(templates).values({
      id: generateId("template"),
      slug: templateSlug,
      project_id: projectId,
      name: templateSlug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    eventBus = new EventBus();
    app = createApp({ db, eventBus });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("emits review.created for the step-1 review on POST /chain-runs", async () => {
    const received: EventData[] = [];
    const off = eventBus.on("review.created", (e) => {
      received.push(e);
    });

    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set(auth())
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            { id: "s1", template: templateSlug, assignee: { kind: "user", email: "alice@x.com" } },
            { id: "s2", template: templateSlug, assignee: { kind: "user", email: "bob@x.com" } },
          ],
        },
        initial_payload: { content: "kickoff" },
      });

    expect(res.status).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      review_id: res.body.step_1_review_id,
      template: templateSlug,
      project_id: projectId,
      priority: "normal",
    });
    expect(typeof received[0].created_at).toBe("string");
    off();
  });

  it("emits review.urgent in addition to review.created for high-priority chain step", async () => {
    const created: EventData[] = [];
    const urgent: EventData[] = [];
    const offCreated = eventBus.on("review.created", (e) => {
      created.push(e);
    });
    const offUrgent = eventBus.on("review.urgent", (e) => {
      urgent.push(e);
    });

    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set(auth())
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            {
              id: "s1",
              template: templateSlug,
              priority: "high",
              assignee: { kind: "user", email: "alice@x.com" },
            },
            { id: "s2", template: templateSlug, assignee: { kind: "user", email: "bob@x.com" } },
          ],
        },
        initial_payload: { content: "high-pri kickoff" },
      });

    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(urgent).toHaveLength(1);
    expect(urgent[0].review_id).toBe(res.body.step_1_review_id);
    expect(urgent[0].priority).toBe("high");
    offCreated();
    offUrgent();
  });

  it("threads chain context fields onto step-1 review.created emit (P1 observability)", async () => {
    // POST /chain-runs step-1 emit must carry chain_run_id + chain_step_id +
    // step_index + total_steps so the dashboard can invalidate
    // ["review-chain", reviewId] on receive instead of polling.
    const received: EventData[] = [];
    const off = eventBus.on("review.created", (e) => {
      received.push(e);
    });

    const res = await request(app)
      .post("/api/v1/chain-runs")
      .set(auth())
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            { id: "s1", template: templateSlug, assignee: { kind: "user", email: "alice@x.com" } },
            { id: "s2", template: templateSlug, assignee: { kind: "user", email: "bob@x.com" } },
            { id: "s3", template: templateSlug, assignee: { kind: "user", email: "carol@x.com" } },
          ],
        },
        initial_payload: { content: "chainctx kickoff" },
      });

    expect(res.status).toBe(201);
    expect(received).toHaveLength(1);
    const evt = received[0];
    expect(evt.chain_run_id).toBe(res.body.id);
    expect(typeof evt.chain_step_id).toBe("string");
    expect(evt.chain_step_id?.startsWith("gw_step_")).toBe(true);
    expect(evt.step_index).toBe(1);
    expect(evt.total_steps).toBe(3);
    off();
  });
});
