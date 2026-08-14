import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews, reviewers } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus, type EventData } from "../services/events";
import { toWirePayload } from "../services/sse-hub";
import { config } from "../config";

// Chain context fields on the SSE wire.
//
// Two scenarios verified end-to-end (route → eventBus → toWirePayload):
//   1. review.decided emitted via /api/v1/reviews/:id/decide on a chain-
//      attached review reaches the wire with all four chain fields populated.
//   2. review.created emitted via POST /api/v1/reviews on a non-chain
//      template reaches the wire WITHOUT chain fields (drops them rather
//      than serialising as null) so non-chain wire payloads stay
//      byte-identical to before.

describe("SSE chain context — decide + non-chain emit shape", () => {
  let app: any;
  let apiKey: string;
  let eventBus: EventBus;
  let projectId: string;
  let chainTemplateSlug: string;
  let nonChainTemplateSlug: string;
  let db: any;
  let aliceEmail: string;
  let aliceToken: string;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    chainTemplateSlug = "ssectx_chain_tpl";
    nonChainTemplateSlug = "ssectx_plain_tpl";

    await db.insert(templates).values({
      id: generateId("template"),
      slug: chainTemplateSlug,
      project_id: projectId,
      name: chainTemplateSlug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
    await db.insert(templates).values({
      id: generateId("template"),
      slug: nonChainTemplateSlug,
      project_id: projectId,
      name: nonChainTemplateSlug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    // Reviewer that matches the chain step 1 assignee (M11 chain-step
    // policy — api_key auth is blocked from deciding chain-attached
    // reviews; need a session-auth JWT for the assigned user).
    aliceEmail = "alice-ssectx@example.com";
    const aliceId = generateId("user");
    await db.insert(reviewers).values({
      id: aliceId,
      email: aliceEmail,
      name: "Alice",
      password_hash: "unused-in-jwt-test",
      role: "reviewer",
      is_active: true,
    });
    aliceToken = jwt.sign({ sub: aliceId, email: aliceEmail }, config.jwtSecret, { audience: "gatewerk-dashboard", issuer: "gatewerk-api" });

    eventBus = new EventBus();
    app = createApp({ db, eventBus });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });
  const sessionAuth = () => ({ Authorization: `Bearer ${aliceToken}` });

  it("review.decided on a chain-attached review reaches the wire with all 4 chain fields", async () => {
    // Spawn a chain so step 1 has chain_run_id + chain_step_id. Step-1
    // assignee is alice (the session reviewer below) so the chain-step
    // policy gate (M11) accepts the decide.
    const createRes = await request(app)
      .post("/api/v1/chain-runs")
      .set(auth())
      .send({
        definition: {
          version: "1.0",
          mode: "sequential",
          rejection_policy: "terminate",
          steps: [
            { id: "s1", template: chainTemplateSlug, assignee: { kind: "user", email: aliceEmail } },
            { id: "s2", template: chainTemplateSlug, assignee: { kind: "user", email: "bob-ssectx@example.com" } },
          ],
        },
        initial_payload: { content: "decide-emit kickoff" },
      });
    expect(createRes.status).toBe(201);
    const reviewId = createRes.body.step_1_review_id;

    const decided: EventData[] = [];
    const off = eventBus.on("review.decided", (e) => {
      decided.push(e);
    });

    const decideRes = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set(sessionAuth())
      .send({ decision: "approved" });
    expect(decideRes.status).toBe(200);

    // The decide route's emit fires synchronously before the response is
    // sent (eventBus.emit is sync), so by the time the response arrives
    // the EventData has been pushed.
    expect(decided).toHaveLength(1);
    const evt = decided[0];

    // Chain fields populated on the in-process EventData.
    expect(evt.chain_run_id).toBe(createRes.body.id);
    expect(typeof evt.chain_step_id).toBe("string");
    expect(evt.chain_step_id?.startsWith("gw_step_")).toBe(true);
    expect(evt.step_index).toBe(1);
    expect(evt.total_steps).toBe(2);

    // Wire payload (what the SSE consumer sees) carries them too.
    const wire = toWirePayload("review.decided", evt);
    expect(wire.chain_run_id).toBe(evt.chain_run_id);
    expect(wire.chain_step_id).toBe(evt.chain_step_id);
    expect(wire.step_index).toBe(1);
    expect(wire.total_steps).toBe(2);

    off();
  });

  it("review.created via POST /reviews on a non-chain template emits without chain fields", async () => {
    const created: EventData[] = [];
    const off = eventBus.on("review.created", (e) => {
      created.push(e);
    });

    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: nonChainTemplateSlug,
        payload: { content: "non-chain payload" },
      });
    expect(res.status).toBe(201);

    expect(created).toHaveLength(1);
    const evt = created[0];

    // Sanity: the underlying review row is not chain-attached.
    const [row] = await db.select().from(reviews).where(eq(reviews.id, evt.review_id));
    expect(row.chain_run_id).toBeNull();
    expect(row.chain_step_id).toBeNull();

    // EventData carries no chain fields.
    expect(evt.chain_run_id).toBeUndefined();
    expect(evt.chain_step_id).toBeUndefined();
    expect(evt.step_index).toBeUndefined();
    expect(evt.total_steps).toBeUndefined();

    // Wire payload drops them (no `null` either).
    const wire = toWirePayload("review.created", evt);
    expect(wire).not.toHaveProperty("chain_run_id");
    expect(wire).not.toHaveProperty("chain_step_id");
    expect(wire).not.toHaveProperty("step_index");
    expect(wire).not.toHaveProperty("total_steps");

    off();
  });
});
