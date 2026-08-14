// HMAC-at-rest tests.
// Verifies three properties of the design:
//   1. No hmac_secret column on webhook_deliveries rows.
//   2. Outgoing signature uses the current project secret (not a row snapshot).
//   3. Rotation between attempts: second attempt signs with the new secret.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import {
  projects,
  templates,
  reviews,
  webhookDeliveries,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { WebhookService } from "../services/webhooks";
import { WebhookRetryWorker } from "../services/webhook-retry-worker";

describe("HMAC at rest (Block 6 C1)", () => {
  let db: any;
  let projectId: string;
  let reviewId: string;
  let templateId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;

    templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "hmac-at-rest-tpl",
      project_id: projectId,
      name: "HMAC At Rest Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    });

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: "hmac-at-rest-tpl",
      payload: { content: "test" },
      callback_url: "https://receiver.example.com/wh",
    }).returning();
    reviewId = rev.id;
  });

  it("1. delivery row has no hmac_secret key after insert", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const ws = new WebhookService({ fetch: mockFetch, db });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://receiver.example.com/wh",
      hmac_secret: "some-project-secret",
      review_id: reviewId,
      decision: "approved",
      decided_at: new Date().toISOString(),
    });

    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The column was dropped — it must not appear on any returned row.
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "hmac_secret")).toBe(false);
    }
  });

  it("2. outgoing signature uses the current project secret", async () => {
    const projectSecret = "current-project-secret-S1"; // nosemgrep
    await db
      .update(projects)
      .set({ hmac_secret: projectSecret })
      .where(eq(projects.id, projectId));

    const captured: { headers: Record<string, string>; body: string } = { headers: {}, body: "" };
    const mockFetch = vi.fn().mockImplementation(async (_url: any, init: any) => {
      captured.headers = init.headers as Record<string, string>;
      captured.body = init.body as string;
      return new Response("ok", { status: 200 });
    });
    const ws = new WebhookService({ fetch: mockFetch, db });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://receiver.example.com/wh",
      hmac_secret: projectSecret,
      review_id: reviewId,
      decision: "approved",
      decided_at: new Date().toISOString(),
    });

    const sigHeader = captured.headers["X-Webhook-Signature"];
    expect(sigHeader).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expectedHex = createHmac("sha256", projectSecret) // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      .update(captured.body)
      .digest("hex");
    expect(sigHeader).toBe(`sha256=${expectedHex}`);
  });

  it("3. rotation between attempts: retry signs with the NEW project secret", async () => {
    const secretBeforeRotation = "secret-before-rotation-S1"; // nosemgrep
    const secretAfterRotation  = "secret-after-rotation-S2";  // nosemgrep

    // Set initial project secret.
    await db
      .update(projects)
      .set({ hmac_secret: secretBeforeRotation })
      .where(eq(projects.id, projectId));

    // Insert a pending delivery (no hmac_secret column).
    const deliveryId = generateId("delivery");
    const payload = { type: "review.decided", review_id: reviewId };
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://receiver.example.com/wh",
      payload,
      status: "pending",
      attempts: 1,
      next_attempt_at: new Date(Date.now() - 1000), // past: eligible
    });

    // Rotate the project secret BEFORE the retry fires.
    await db
      .update(projects)
      .set({ hmac_secret: secretAfterRotation })
      .where(eq(projects.id, projectId));

    // Capture the outgoing signature from the retry attempt.
    let capturedSig = "";
    let capturedBody = "";
    const mockFetch = vi.fn().mockImplementation(async (_url: any, init: any) => {
      const h = init.headers as Record<string, string>;
      capturedSig  = h["X-Webhook-Signature"];
      capturedBody = init.body as string;
      return new Response("ok", { status: 200 });
    });

    const ws = new WebhookService({ fetch: mockFetch, db });
    const worker = new WebhookRetryWorker({ db, webhooks: ws });

    const processed = await worker.processRetries();
    expect(processed).toBe(1);

    // Retry MUST use the NEW (post-rotation) secret.
    const newHex = createHmac("sha256", secretAfterRotation) // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      .update(capturedBody)
      .digest("hex");
    expect(capturedSig).toBe(`sha256=${newHex}`);

    // And must NOT use the pre-rotation secret.
    const oldHex = createHmac("sha256", secretBeforeRotation) // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      .update(capturedBody)
      .digest("hex");
    expect(capturedSig).not.toBe(`sha256=${oldHex}`);
  });
});
