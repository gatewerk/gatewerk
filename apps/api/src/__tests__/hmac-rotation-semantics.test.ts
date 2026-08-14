import { describe, it, expect, vi, afterAll } from "vitest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import {
  projects,
  templates,
  reviews,
  webhookDeliveries,
} from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { WebhookService } from "../services/webhooks";
import { WebhookRetryWorker } from "../services/webhook-retry-worker";

// Block 6 C1 — revised from launch-readiness Phase 1 §5 F5.
// Old contract (F5): pending retries signed with the enqueue-time secret
//   stored in webhook_deliveries.hmac_secret.
// New contract: retry signature uses the project's CURRENT projects.hmac_secret
//   at attempt time, resolved via JOIN (webhook_deliveries → reviews → projects).
//   The webhook_deliveries.hmac_secret column was dropped in migration 057.
//   Rotation between attempts is by-design — receivers dedupe via delivery_id.
describe("HMAC rotation semantics (Block 6 C1 — current-secret-at-retry)", () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("ok", { status: 200 }));

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it("pending retry signs with the CURRENT project secret after rotation", async () => {
    const { db } = await createTestDb();
    const { project } = await seedTestProject(db);

    // Step 1: establish initial project secret.
    const enqueueTimeSecret = "enqueue-time-secret-PRE-rotate";
    await db
      .update(projects)
      .set({ hmac_secret: enqueueTimeSecret })
      .where(eq(projects.id, project.id));

    // Step 2: seed a review + a pending webhook_delivery row (no hmac_secret
    // column — dropped in migration 057).
    const templateId = generateId("template");
    await db.insert(templates).values({
      id: templateId,
      slug: "hmac-rotate-template",
      project_id: project.id,
      name: "HMAC Rotate Template",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: project.id,
      template_id: templateId,
      template_slug: "hmac-rotate-template",
      payload: { content: "rotated before retry" },
      status: "decided",
    });

    const deliveryId = generateId("delivery");
    const payload = { type: "review.decided", review_id: reviewId };
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      review_id: reviewId,
      event_type: "review.decided",
      url: "https://receiver.example.com/webhook",
      payload,
      status: "pending",
      attempts: 1,
      next_attempt_at: new Date(Date.now() - 1000), // past: eligible for retry
    });

    // Step 3: rotate the project's secret. The new secret is what the retry
    // worker MUST use (new contract: current secret at attempt time).
    const rotatedSecret = "rotated-secret-POST-rotate";
    await db
      .update(projects)
      .set({ hmac_secret: rotatedSecret })
      .where(eq(projects.id, project.id));

    // Step 4: capture the outgoing fetch.
    fetchSpy.mockClear();

    const webhooks = new WebhookService({
      db,
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
    });
    const worker = new WebhookRetryWorker({ db, webhooks });

    const processed = await worker.processRetries();
    expect(processed).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [fetchUrl, fetchInit] = fetchSpy.mock.calls[0];
    expect(String(fetchUrl)).toBe("https://receiver.example.com/webhook");

    const headers = (fetchInit as RequestInit).headers as Record<string, string>;
    const v1Header = headers["X-Webhook-Signature"];
    expect(v1Header).toMatch(/^sha256=[0-9a-f]{64}$/);

    const body = String((fetchInit as RequestInit).body);

    // New contract: the retry MUST sign with the CURRENT (rotated) secret.
    const rotatedHex = createHmac("sha256", rotatedSecret) // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      .update(body)
      .digest("hex");
    expect(v1Header).toBe(`sha256=${rotatedHex}`);

    // And must NOT sign with the pre-rotation secret.
    const preRotateHex = createHmac("sha256", enqueueTimeSecret) // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
      .update(body)
      .digest("hex");
    expect(v1Header).not.toBe(`sha256=${preRotateHex}`);
  });
});
