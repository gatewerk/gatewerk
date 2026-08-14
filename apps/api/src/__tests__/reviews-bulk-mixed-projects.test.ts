import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHash } from "crypto";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { apiKeys, projects, reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";

// Bulk endpoints reject mixed-project arrays.
//
// Pre-fix:
//   bulk.ts resolved the active project from `ids[0]` and the underlying
//   service applied an `eq(project_id, projectId)` filter that silently
//   dropped any id from a different project. The route's response
//   `{ ok: true, count }` then under-reported the actual mutation, hiding
//   the cross-project drift from the caller.
//
// Fix:
//   The route now selects all rows for `inArray(reviews.id, ids)`, asserts
//   their project_ids are a single-element set, and returns 400
//   mixed_projects if not. Empty `ids` is handled separately as
//   ids_empty (also new). All-unknown ids → 404 review_not_found.
describe("reviews bulk endpoints — mixed-project rejection (Wave 3 P2)", () => {
  let app: any;
  let db: any;
  let projectA: any;
  let projectB: any;
  let apiKeyA: string;
  let templateA: any;
  let templateB: any;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;

    const seedA = await seedTestProject(db);
    projectA = seedA.project;
    apiKeyA = seedA.apiKey;

    [projectB] = await db.insert(projects).values({
      id: generateId("project"),
      name: "Project B (bulk mixed)",
      hmac_secret: "project-b-bulk-mixed",
    }).returning();
    const rawKeyB = "gwk_bulkB" + Math.random().toString(36).slice(2, 14);
    await db.insert(apiKeys).values({
      id: generateId("api_key"),
      project_id: projectB.id,
      key_hash: createHash("sha256").update(rawKeyB).digest("hex"),
      key_prefix: rawKeyB.slice(0, 10),
      label: "project-b-bulk",
      scopes: [...ALL_SCOPES],
    });

    [templateA] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "bulk-tmpl-a",
      project_id: projectA.id,
      name: "Bulk A template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();
    [templateB] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "bulk-tmpl-b",
      project_id: projectB.id,
      name: "Bulk B template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_priority: "normal",
    }).returning();

    app = createApp({ db });
  });

  // `status` defaults to pending because most cases here assert that a
  // rejected bulk request mutated nothing. Cases that need the bulk op to
  // actually succeed must seed a TERMINAL row: bulk archive/delete are gated
  // on decided|expired (services/reviews/bulk.ts).
  async function seedReview(
    projectId: string,
    templateSlug: string,
    status = "pending",
  ): Promise<string> {
    const [row] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_slug: templateSlug,
      payload: { content: "x" },
      priority: "normal",
      status,
      ...(status === "decided"
        ? { decision: "approved", decided_at: new Date(), decided_by: "reviewer:test" }
        : {}),
    }).returning();
    return row.id;
  }

  it("POST /bulk/archive — single-project array → 200, count matches", async () => {
    const id1 = await seedReview(projectA.id, templateA.slug, "decided");
    const id2 = await seedReview(projectA.id, templateA.slug, "decided");
    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({ ids: [id1, id2] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("POST /bulk/archive — mixed-project array → 400 mixed_projects, no mutation", async () => {
    const idA = await seedReview(projectA.id, templateA.slug);
    const idB = await seedReview(projectB.id, templateB.slug);
    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({ ids: [idA, idB] });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("mixed_projects");

    // Sanity: neither row was archived (status remains pending).
    const { eq, inArray } = await import("drizzle-orm");
    void eq; // imported for type completeness; we use inArray below
    const rows = await db
      .select({ id: reviews.id, status: reviews.status })
      .from(reviews)
      .where(inArray(reviews.id, [idA, idB]));
    for (const r of rows) {
      expect(r.status).toBe("pending");
    }
  });

  it("POST /bulk/delete — mixed-project array → 400 mixed_projects, no mutation", async () => {
    const idA = await seedReview(projectA.id, templateA.slug);
    const idB = await seedReview(projectB.id, templateB.slug);
    const res = await request(app)
      .post("/api/v1/reviews/bulk/delete")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({ ids: [idA, idB] });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("mixed_projects");

    // Sanity: both rows still exist.
    const { inArray } = await import("drizzle-orm");
    const remaining = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(inArray(reviews.id, [idA, idB]));
    expect(remaining).toHaveLength(2);
  });

  it("POST /bulk/archive — all-unknown ids → 404 review_not_found", async () => {
    const res = await request(app)
      .post("/api/v1/reviews/bulk/archive")
      .set("Authorization", `Bearer ${apiKeyA}`)
      .send({ ids: ["gw_review_doesnotexist1", "gw_review_doesnotexist2"] });
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe("review_not_found");
  });
});
