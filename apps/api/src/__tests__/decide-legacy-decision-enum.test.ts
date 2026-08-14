// The legacy /decide alias must not accept server-written outcome values as
// caller input (S1).
//
// ReviewDecideBodySchema.decision reused the full 8-value DECISIONS enum, and
// routes/reviews/decide.ts maps every non-'rejected' value to
// action_id='approve'. So `POST /reviews/:id/decide {decision:"expired"}`
// returned 200 with a terminal APPROVAL: approved_value stamped, a
// review.decided webhook telling the agent to execute, and an audit row reading
// `approved` with no trace that the caller asked for something else.
//
// `expired` and `max_iterations_reached` are values the API itself WRITES into
// reviews.decision, so echoing one back is the natural integrator mistake —
// and sdk-ts types this field as a bare `string`, so nothing upstream stopped
// it.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";

describe("POST /reviews/:id/decide — decision enum", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;

  const SLUG = "decide-enum";
  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });

    await db.insert(templates).values({
      id: generateId("template"),
      slug: SLUG,
      project_id: projectId,
      name: "Decide enum",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });
  });

  async function newReview() {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: SLUG, payload: { content: "x" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function row(id: string) {
    const [r] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id));
    return r;
  }

  for (const outcome of ["expired", "retried", "max_iterations_reached"]) {
    it(`refuses decision:"${outcome}" instead of silently approving`, async () => {
      const id = await newReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${id}/decide`)
        .set(auth())
        .send({ decision: outcome });

      expect(res.status).toBe(422);

      const r = await row(id);
      expect(r.status).toBe("pending");
      expect(r.decision).toBeNull();
      expect(r.decided_at).toBeNull();
      expect(r.approved_value).toBeNull();
    });
  }

  it("still accepts approved", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/decide`)
      .set(auth())
      .send({ decision: "approved" });

    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.status).toBe("decided");
    expect(r.decision).toBe("approved");
  });

  it("still accepts rejected", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/decide`)
      .set(auth())
      .send({ decision: "rejected" });

    expect(res.status).toBe(200);
    expect((await row(id)).decision).toBe("rejected");
  });

  it("still accepts edited (approve-with-edits legacy semantic)", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/decide`)
      .set(auth())
      .send({ decision: "edited" });

    expect(res.status).toBe(200);
    expect((await row(id)).decision).toBe("edited");
  });

  it("keeps the actionable monitoring redirect for confirmed and vetoed", async () => {
    // These stay admitted by the schema on purpose: the route answers with
    // use_monitoring_endpoints, which is a better answer than a generic enum
    // error and is documented in sdk-ts/src/errors.ts.
    for (const outcome of ["confirmed", "vetoed"]) {
      const id = await newReview();
      const res = await request(app)
        .post(`/api/v1/reviews/${id}/decide`)
        .set(auth())
        .send({ decision: outcome });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("use_monitoring_endpoints");
      expect((await row(id)).status).toBe("pending");
    }
  });
});
