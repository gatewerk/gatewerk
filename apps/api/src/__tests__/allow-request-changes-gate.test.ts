// `allow_request_changes` is a real gate as of S1.
//
// The column shipped with a DB default of TRUE, was validated on both template
// body schemas, and was projected onto every review response — with ZERO
// readers anywhere in the repo. A template that set it false still accepted
// iteration actions. The DB schema comment claimed templates "opt out via
// TemplateEditor toggles"; no such toggle exists.
//
// Gated on the resolved action's KIND, not the id: preset injection makes
// `request_changes` succeed on every template whether authored or not, and a
// template's own custom iteration actions must obey the same switch.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";

describe("allow_request_changes gate", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;

  const OPEN_SLUG = "arc-allowed";
  const CLOSED_SLUG = "arc-disallowed";
  const CUSTOM_SLUG = "arc-custom-iteration";

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });
  const FIELDS = [{ name: "content", type: "text", label: "Content" }];

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });

    await db.insert(templates).values([
      {
        id: generateId("template"),
        slug: OPEN_SLUG,
        project_id: projectId,
        name: "Iterations allowed",
        fields: FIELDS,
        actions: ["approve", "reject"],
        allow_request_changes: true,
      },
      {
        id: generateId("template"),
        slug: CLOSED_SLUG,
        project_id: projectId,
        name: "Iterations disallowed",
        fields: FIELDS,
        actions: ["approve", "reject"],
        allow_request_changes: false,
      },
      {
        id: generateId("template"),
        slug: CUSTOM_SLUG,
        project_id: projectId,
        name: "Custom iteration action, iterations disallowed",
        fields: FIELDS,
        actions: [
          { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
          { id: "send_back", label: "Send back", kind: "iteration" },
        ],
        allow_request_changes: false,
      },
    ]);
  });

  async function newReview(slug: string) {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: slug, payload: { content: "x" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function row(id: string) {
    const [r] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id));
    return r;
  }

  it("allows request_changes when the template permits it", async () => {
    const id = await newReview(OPEN_SLUG);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "request_changes", feedback: "please revise" });

    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe("awaiting_iteration");
  });

  it("refuses the injected request_changes preset when the template disallows it", async () => {
    // The preset is injected for every template, authored or not, so gating on
    // the authored vocabulary alone would have missed this.
    const id = await newReview(CLOSED_SLUG);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "request_changes", feedback: "please revise" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("request_changes_not_allowed");
    expect((await row(id)).status).toBe("pending");
  });

  it("refuses a template's OWN custom iteration action when it disallows iterations", async () => {
    const id = await newReview(CUSTOM_SLUG);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "send_back", feedback: "needs work" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("request_changes_not_allowed");
    expect((await row(id)).status).toBe("pending");
  });

  it("still allows decisions on a template that disallows iterations", async () => {
    const id = await newReview(CLOSED_SLUG);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve" });

    expect(res.status).toBe(200);
    expect((await row(id)).decision).toBe("approved");
  });

  it("refuses the legacy /retry alias too, not just /action", async () => {
    const id = await newReview(CLOSED_SLUG);
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/retry`)
      .set(auth())
      .send({ feedback: "please revise" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("request_changes_not_allowed");
    expect((await row(id)).status).toBe("pending");
  });

  it("leaves cancel_iteration reachable so disabling the flag cannot strand a review", async () => {
    // A review can already be sitting in awaiting_iteration when the operator
    // flips the flag off. cancel_iteration is kind side_effect, so it must
    // still work — otherwise the flag becomes a trap.
    const id = await newReview(OPEN_SLUG);
    await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "request_changes", feedback: "revise" });
    expect((await row(id)).status).toBe("awaiting_iteration");

    await db
      .update(templates)
      .set({ allow_request_changes: false })
      .where(eq(templates.slug, OPEN_SLUG));

    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "cancel_iteration" });

    expect(res.status).toBe(200);
    expect((await row(id)).status).toBe("pending");

    await db
      .update(templates)
      .set({ allow_request_changes: true })
      .where(eq(templates.slug, OPEN_SLUG));
  });
});
