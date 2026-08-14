import { describe, it, expect, beforeAll } from "vitest";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { reviews, templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { TimeoutWorker } from "../services/timeout-worker";
import { WebhookService } from "../services/webhooks";
import { EventBus } from "../services/events";
import { eq } from "drizzle-orm";
import { vi } from "vitest";

describe("Worker claiming", () => {
  let db: any;
  let projectId: string;
  let templateId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "claim-test",
      project_id: projectId,
      name: "Claim Test",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    templateId = tpl.id;

    // Insert an expired review
    await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: tpl.id,
      template_slug: "claim-test",
      payload: { text: "expired" },
      callback_url: "https://example.com/cb",
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 10000),
    });
  });

  it("claimed review has claimed_by set after processExpired", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch, db });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const processed = await worker.processExpired();

    expect(processed).toBe(1);

    // After processing, claimed_by should be cleared (set to null in the final UPDATE)
    const [review] = await db.select().from(reviews).where(eq(reviews.status, "expired"));
    expect(review).toBeTruthy();
    expect(review.claimed_by).toBeNull(); // Cleared after successful processing
  });

  it("already-claimed review is not re-processed within claim timeout", async () => {
    // Insert another expired review, pre-claimed by another worker
    await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: "claim-test",
      payload: { text: "pre-claimed" },
      callback_url: "https://example.com/cb",
      status: "pending",
      timeout_action: "expire",
      timeout_seconds: 60,
      expires_at: new Date(Date.now() - 10000),
      claimed_by: "other-worker-123",
      claimed_at: new Date(), // Claimed just now — within timeout window
    });

    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const webhooks = new WebhookService({ fetch: mockFetch, db });
    const eventBus = new EventBus();

    const worker = new TimeoutWorker({ db, webhooks, eventBus });
    const processed = await worker.processExpired();

    // Should NOT process the pre-claimed review (claim is still fresh)
    expect(processed).toBe(0);
  });
});
