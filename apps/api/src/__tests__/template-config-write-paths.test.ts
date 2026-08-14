// Template configuration axes that were settable-in-principle but had no
// complete write path.
//
// Three distinct defects, all of the same shape — a knob the product validates
// and reads but cannot be set:
//
//  1. `max_iterations`: DB column + CHECK + Zod on both body schemas + read-side
//     inheritance in reviews/crud.ts + worker enforcement all shipped, but NO
//     route destructured it, NO service signature carried it, and publish()'s
//     `mappable` list omitted it. Reachable only by direct SQL.
//  2. `changes_timeout_hours`: on TemplateUpdateBodySchema, absent from
//     TemplateCreateBodySchema. Because z.object() STRIPS unknown keys, a
//     create that sent it got a 201 with the value silently discarded — the
//     worst failure mode available.
//  3. template `slug`: publish()'s `mappable` omitted "slug", so a template
//     created through the UI draft flow kept its `draft-xxxxxxxx` placeholder
//     forever, even though the editor exposes a slug input while the template
//     is a draft (DetailEditConfig.tsx).
//
// Slug promotion is FIRST-PUBLISH ONLY. That is not a limitation, it is the
// invariant: execute-action.ts resolves a review's action vocabulary from the
// live template row BY SLUG via reviews.template_slug, so renaming a live
// template would silently strip custom actions from every in-flight review.
// A draft template refuses review creation outright (crud.ts template_draft),
// so at first publish there provably are no in-flight reviews to orphan.

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { EventBus } from "../services/events";

describe("template configuration write paths", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });
  const FIELDS = [{ name: "content", type: "text", label: "Content" }];
  const ACTIONS = [
    { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
  ];

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });
  });

  async function rowById(id: string) {
    const [r] = await db.select().from(templates).where(eq(templates.id, id));
    return r;
  }

  async function createTemplate(body: Record<string, unknown>) {
    return request(app).post("/api/v1/templates").set(auth()).send({
      name: "T",
      fields: FIELDS,
      actions: ACTIONS,
      ...body,
    });
  }

  describe("max_iterations", () => {
    it("POST /templates persists max_iterations", async () => {
      const res = await createTemplate({ slug: "mi-create", max_iterations: 5 });
      expect(res.status).toBe(201);
      expect((await rowById(res.body.id)).max_iterations).toBe(5);
      // Also has to survive the read path onto the wire, or the editor can
      // never show the operator what they configured.
      expect(res.body.max_iterations).toBe(5);
    });

    it("POST /templates without max_iterations leaves it uncapped", async () => {
      const res = await createTemplate({ slug: "mi-create-absent" });
      expect(res.status).toBe(201);
      expect((await rowById(res.body.id)).max_iterations).toBeNull();
    });

    it("PUT /templates/:id sets max_iterations", async () => {
      const created = await createTemplate({ slug: "mi-update" });
      const res = await request(app)
        .put(`/api/v1/templates/${created.body.id}`)
        .set(auth())
        .send({ max_iterations: 7 });
      expect(res.status).toBe(200);
      expect((await rowById(created.body.id)).max_iterations).toBe(7);
    });

    it("PUT /templates/:id clears max_iterations with an explicit null", async () => {
      const created = await createTemplate({ slug: "mi-clear", max_iterations: 4 });
      const res = await request(app)
        .put(`/api/v1/templates/${created.body.id}`)
        .set(auth())
        .send({ max_iterations: null });
      expect(res.status).toBe(200);
      expect((await rowById(created.body.id)).max_iterations).toBeNull();
    });

    it("PUT /templates/:id leaves max_iterations untouched when the key is absent", async () => {
      const created = await createTemplate({ slug: "mi-patch-semantics", max_iterations: 9 });
      const res = await request(app)
        .put(`/api/v1/templates/${created.body.id}`)
        .set(auth())
        .send({ name: "renamed" });
      expect(res.status).toBe(200);
      expect((await rowById(created.body.id)).max_iterations).toBe(9);
    });

    it("rejects max_iterations = 0 at the wire rather than at the CHECK constraint", async () => {
      const res = await createTemplate({ slug: "mi-zero", max_iterations: 0 });
      expect(res.status).toBe(422);
    });
  });

  describe("changes_timeout_hours", () => {
    it("POST /templates persists changes_timeout_hours instead of silently dropping it", async () => {
      const res = await createTemplate({ slug: "cth-create", changes_timeout_hours: 12 });
      expect(res.status).toBe(201);
      expect((await rowById(res.body.id)).changes_timeout_hours).toBe(12);
      expect(res.body.changes_timeout_hours).toBe(12);
    });

    it("PUT /templates/:id sets changes_timeout_hours (regression lock)", async () => {
      const created = await createTemplate({ slug: "cth-update" });
      const res = await request(app)
        .put(`/api/v1/templates/${created.body.id}`)
        .set(auth())
        .send({ changes_timeout_hours: 24 });
      expect(res.status).toBe(200);
      expect((await rowById(created.body.id)).changes_timeout_hours).toBe(24);
    });

    it("rejects changes_timeout_hours = 0 at the wire", async () => {
      const res = await createTemplate({ slug: "cth-zero", changes_timeout_hours: 0 });
      expect(res.status).toBe(422);
    });
  });

  describe("slug uniqueness", () => {
    it("POST /templates translates a duplicate slug into a field-level 4xx", async () => {
      // Never exercised before S1: the test harness had no
      // templates_project_id_slug_uniq index, so the 23505 branch in the
      // create route was unreachable in CI while live in production.
      await createTemplate({ slug: "dupe-slug" });
      const res = await createTemplate({ slug: "dupe-slug" });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("slug_already_exists");
    });
  });

  describe("slug promotion on first publish", () => {
    async function newDraft(initial: Record<string, unknown> = {}) {
      const res = await request(app)
        .post("/api/v1/templates/draft")
        .set(auth())
        .send(initial);
      expect(res.status).toBe(201);
      return res.body;
    }

    async function patchDraft(id: string, draft: Record<string, unknown>) {
      const res = await request(app)
        .patch(`/api/v1/templates/${id}/draft`)
        .set(auth())
        .send(draft);
      expect(res.status).toBe(200);
      return res.body;
    }

    it("a fresh draft starts with a placeholder slug", async () => {
      const draft = await newDraft();
      // Must itself be a legal slug: it sits in the slug column, and publish()
      // validates what it promotes. generateId is base64url, so the raw tail
      // could carry uppercase / `-` / `_`.
      expect(draft.slug).toMatch(/^draft-[a-z0-9]{8}$/);
      expect(draft.status).toBe("draft");
    });

    it("first publish promotes the slug the operator typed", async () => {
      const draft = await newDraft();
      await patchDraft(draft.id, {
        name: "Deploy approval",
        slug: "deploy-approval",
        fields: FIELDS,
        actions: ACTIONS,
      });

      const res = await request(app)
        .post(`/api/v1/templates/${draft.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(200);

      const row = await rowById(draft.id);
      expect(row.slug).toBe("deploy-approval");
      expect(row.status).toBe("active");
      // And the promoted slug is the one agents address the template by.
      const created = await request(app)
        .post("/api/v1/reviews")
        .set(auth())
        .send({ template: "deploy-approval", payload: { content: "ship it" } });
      expect(created.status).toBe(201);
    });

    it("first publish promotes max_iterations from the draft", async () => {
      const draft = await newDraft();
      await patchDraft(draft.id, {
        name: "Capped",
        slug: "capped-loop",
        fields: FIELDS,
        actions: ACTIONS,
        max_iterations: 2,
      });
      const res = await request(app)
        .post(`/api/v1/templates/${draft.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(200);
      expect((await rowById(draft.id)).max_iterations).toBe(2);
    });

    it("first publish rejects a malformed slug instead of writing it", async () => {
      const draft = await newDraft();
      await patchDraft(draft.id, {
        name: "Bad",
        slug: "Not A Slug",
        fields: FIELDS,
        actions: ACTIONS,
      });
      const res = await request(app)
        .post(`/api/v1/templates/${draft.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(400);
      // The placeholder must survive a rejected publish.
      expect((await rowById(draft.id)).slug).toMatch(/^draft-/);
      expect((await rowById(draft.id)).status).toBe("draft");
    });

    it("first publish surfaces a slug collision as a clean 4xx, not a raw constraint error", async () => {
      await createTemplate({ slug: "taken-slug" });
      const draft = await newDraft();
      await patchDraft(draft.id, {
        name: "Collides",
        slug: "taken-slug",
        fields: FIELDS,
        actions: ACTIONS,
      });
      const res = await request(app)
        .post(`/api/v1/templates/${draft.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("taken-slug");
      expect((await rowById(draft.id)).status).toBe("draft");
    });

    it("republishing a live template refuses a slug change rather than silently ignoring it", async () => {
      // The editor locks the slug input once the template is live
      // (DetailEditConfig.tsx) precisely because renaming would orphan
      // in-flight reviews, which carry reviews.template_slug. A draft that
      // somehow carries a different slug is a client bug — say so loudly.
      const created = await createTemplate({ slug: "live-slug" });
      await patchDraft(created.body.id, {
        name: "Renamed",
        slug: "different-slug",
        fields: FIELDS,
        actions: ACTIONS,
      });
      const res = await request(app)
        .post(`/api/v1/templates/${created.body.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain("slug_immutable_after_publish");
      expect((await rowById(created.body.id)).slug).toBe("live-slug");
    });

    it("republishing a live template with an unchanged slug is a no-op", async () => {
      const created = await createTemplate({ slug: "same-slug" });
      await patchDraft(created.body.id, {
        name: "Same slug, new name",
        slug: "same-slug",
        fields: FIELDS,
        actions: ACTIONS,
      });
      const res = await request(app)
        .post(`/api/v1/templates/${created.body.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(200);
      const row = await rowById(created.body.id);
      expect(row.slug).toBe("same-slug");
      expect(row.name).toBe("Same slug, new name");
    });

    it("republishing a live template whose draft omits slug entirely is a no-op", async () => {
      const created = await createTemplate({ slug: "omitted-slug" });
      await patchDraft(created.body.id, { name: "No slug key", fields: FIELDS, actions: ACTIONS });
      const res = await request(app)
        .post(`/api/v1/templates/${created.body.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(200);
      expect((await rowById(created.body.id)).slug).toBe("omitted-slug");
    });

    it("an empty-string slug in the draft does not overwrite the placeholder", async () => {
      // The editor initialises slug to "" on a brand-new draft
      // (createDraft writes draft_config.slug = initial.slug || "").
      // Publishing before the operator types anything must not write "".
      const draft = await newDraft({ name: "Untitled" });
      await patchDraft(draft.id, { name: "Untitled", slug: "", fields: FIELDS, actions: ACTIONS });
      const res = await request(app)
        .post(`/api/v1/templates/${draft.id}/publish`)
        .set(auth())
        .send({});
      expect(res.status).toBe(200);
      expect((await rowById(draft.id)).slug).toMatch(/^draft-/);
      expect((await rowById(draft.id)).status).toBe("active");
    });
  });
});
