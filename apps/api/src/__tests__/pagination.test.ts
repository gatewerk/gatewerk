import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createReviewService } from "../services/reviews";

describe("Pagination", () => {
  let db: any;
  let projectId: string;
  let reviewService: ReturnType<typeof createReviewService>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    reviewService = createReviewService(db);

    // Create a template
    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "pagination-test",
      project_id: projectId,
      name: "Pagination Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    // Insert 5 reviews
    for (let i = 0; i < 5; i++) {
      await db.insert(reviews).values({
        id: generateId("review"),
        project_id: projectId,
        template_id: tpl.id,
        template_slug: "pagination-test",
        payload: { text: `review-${i}` },
        callback_url: "https://example.com/cb",
        status: "pending",
      });
    }
  });

  it("returns correct total count independent of page size", async () => {
    const result = await reviewService.list(projectId, { limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.has_more).toBe(true);
  });

  it("returns has_more=false on last page", async () => {
    const result = await reviewService.list(projectId, { limit: 10 });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.has_more).toBe(false);
  });

  it("handles offset correctly", async () => {
    const result = await reviewService.list(projectId, { limit: 2, offset: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.has_more).toBe(false);
  });
});
