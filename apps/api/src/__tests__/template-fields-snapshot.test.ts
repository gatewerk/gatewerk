import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { eq } from "drizzle-orm";

describe("P8 template-fields snapshot", () => {
  let app: any, db: any, projectId: string, templateId: string, apiKey: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "snap-test",
      project_id: projectId,
      name: "Snapshot Test",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });
    app = createApp({ db });
  });

  async function createReview(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ template: "snap-test", payload: { content: "hello" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it("snapshots normalized fields at creation", async () => {
    const id = await createReview();
    const res = await request(app)
      .get(`/api/v1/reviews/${id}`)
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body.template_fields).toEqual([
      { name: "content", label: "Content", type: "text", editable: true },
    ]);
  });

  it("serves the snapshot even after the template's fields change", async () => {
    const id = await createReview();
    await db.update(templates)
      .set({ fields: [{ name: "renamed", type: "markdown", label: "Renamed" }] })
      .where(eq(templates.id, templateId));
    const res = await request(app)
      .get(`/api/v1/reviews/${id}`)
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body.template.fields).toEqual([
      { name: "content", label: "Content", type: "text", editable: true },
    ]);
    // restore for other tests
    await db.update(templates)
      .set({ fields: [{ name: "content", type: "text", label: "Content", editable: true }] })
      .where(eq(templates.id, templateId));
  });

  it("still serves fields after template deletion (FK SET NULL)", async () => {
    const id = await createReview();
    await db.delete(templates).where(eq(templates.id, templateId));
    const res = await request(app)
      .get(`/api/v1/reviews/${id}`)
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body.template).toBeNull();
    expect(res.body.template_fields).toEqual([
      { name: "content", label: "Content", type: "text", editable: true },
    ]);
  });

  it("normalizes editable=false and strips unknown keys at snapshot time", async () => {
    // Re-seed template (deleted in prior test)
    const tplId2 = generateId("template");
    await db.insert(templates).values({
      id: tplId2,
      slug: "snap-test2",
      project_id: projectId,
      name: "Snapshot Test 2",
      // editable omitted (should default false), extra 'junk' key present
      fields: [{ name: "note", type: "textarea", label: "Note", junk: "ignored" }],
      actions: ["approve", "reject"],
    });
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ template: "snap-test2", payload: { note: "hi" } });
    expect(res.status).toBe(201);
    const detail = await request(app)
      .get(`/api/v1/reviews/${res.body.id}`)
      .set("Authorization", `Bearer ${apiKey}`);
    expect(detail.body.template_fields).toEqual([
      { name: "note", label: "Note", type: "textarea", editable: false },
    ]);
    // cleanup
    await db.delete(templates).where(eq(templates.id, tplId2));
  });

  it("falls back to live template fields when template_fields is NULL (legacy row)", async () => {
    // Re-seed template (both prior templates deleted)
    const tplId3 = generateId("template");
    await db.insert(templates).values({
      id: tplId3,
      slug: "snap-test3",
      project_id: projectId,
      name: "Snapshot Test 3",
      fields: [{ name: "body", type: "text", label: "Body", editable: true }],
      actions: ["approve", "reject"],
    });
    // Insert a legacy review directly — template_fields NULL simulates a pre-073 row
    const legacyId = generateId("review");
    await db.insert(reviews).values({
      id: legacyId,
      project_id: projectId,
      template_id: tplId3,
      template_slug: "snap-test3",
      payload: { body: "legacy" },
      status: "pending",
      oversight: "blocking",
      // template_fields intentionally omitted (NULL)
    });
    const res = await request(app)
      .get(`/api/v1/reviews/${legacyId}`)
      .set("Authorization", `Bearer ${apiKey}`);
    // No snapshot — must serve live template fields
    expect(res.body.template_fields).toBeNull();
    expect(res.body.template.fields).toEqual([
      { name: "body", label: "Body", type: "text", editable: true },
    ]);
    // cleanup
    await db.delete(templates).where(eq(templates.id, tplId3));
  });
});
