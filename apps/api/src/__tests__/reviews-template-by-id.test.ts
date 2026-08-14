import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, projects } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

/**
 * POST /api/v1/reviews used to resolve `template` by slug only, so the
 * `gw_tpl_` id that GET /api/v1/templates returns as `id` was rejected with
 * template_not_found — an error claiming a template that plainly exists in the
 * project could not be found.
 */
describe("Review creation resolves a template by slug or by id", () => {
  let app: any;
  let apiKey: string;
  let templateId: string;
  let otherProjectTemplateId: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "by-id-review",
      project_id: seed.project.id,
      name: "By Id Review",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    // A template the API key must never be able to reach, to prove that
    // accepting ids did not widen the project scope.
    //
    // Insert the second project directly rather than calling seedTestProject
    // again: that helper hardcodes the raw key "gwk_test1234567890abcdef", so
    // a second call rebinds the same key to the new project and every request
    // in this file would silently authenticate against the wrong one.
    const [otherProject] = await db
      .insert(projects)
      .values({
        id: generateId("project"),
        name: "Other Project",
        hmac_secret: "other-hmac-secret",
      })
      .returning();

    otherProjectTemplateId = generateId("template");
    await db.insert(templates).values({
      id: otherProjectTemplateId,
      slug: "other-project-review",
      project_id: otherProject.id,
      name: "Other Project Review",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve"],
    });

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("accepts a template slug", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "by-id-review", payload: { content: "via slug" } });

    expect(res.status).toBe(201);
    expect(res.body.template_id).toBe(templateId);
  });

  it("accepts a template id, the value GET /templates returns", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: templateId, payload: { content: "via id" } });

    expect(res.status).toBe(201);
    expect(res.body.template_id).toBe(templateId);
    expect(res.body.template_slug).toBe("by-id-review");
  });

  it("still rejects a template belonging to another project", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: otherProjectTemplateId, payload: { content: "should fail" } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template_not_found");
  });

  it("does not claim a template exists nowhere when the name is simply unknown", async () => {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: "no-such-template", payload: { content: "x" } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template_not_found");
    // The old wording asserted the template was "not found in this project"
    // even when it existed and was merely addressed by id. The message must
    // say how templates are addressed instead of making a false claim.
    expect(res.body.error.message).toMatch(/slug or id/i);
  });
});
