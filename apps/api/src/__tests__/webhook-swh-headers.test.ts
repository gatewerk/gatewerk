/**
 * HIGH-8: SWH headers wire-up integration test.
 *
 * Asserts that outbound webhook deliveries carry all three Standard Webhooks
 * headers (webhook-id, webhook-timestamp, webhook-signature) AND that the
 * signature is cryptographically valid against the known HMAC secret.
 *
 * Uses a capture-fetch pattern with an in-memory db (same approach as
 * webhook-retry.test.ts) to avoid any real network or DB dependency.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { WebhookService } from "../services/webhooks";
import { verifySwhSignature } from "../services/webhooks/standard-webhooks";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("WebhookService — SWH headers on outbound delivery", () => {
  let db: any;
  let reviewId: string;

  const HMAC_SECRET = "swh-test-secret-do-not-use-in-prod"; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — integration test fixture, not a production secret

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);

    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: "swh-headers-tpl",
      project_id: seed.project.id,
      name: "SWH Headers Test Template",
      fields: [{ name: "text", type: "text", label: "Text" }],
      actions: ["approve", "reject"],
    }).returning();

    const [rev] = await db.insert(reviews).values({
      id: generateId("review"),
      project_id: seed.project.id,
      template_id: tpl.id,
      template_slug: "swh-headers-tpl",
      payload: { text: "swh test" },
      callback_url: "https://example.com/cb",
    }).returning();
    reviewId = rev.id;
  });

  it("outbound delivery carries webhook-id, webhook-timestamp, and webhook-signature headers", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;

    const captureFetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      capturedBody = typeof opts?.body === "string" ? opts.body : undefined;
      return new Response("ok", { status: 200 });
    });

    const ws = new WebhookService({ fetch: captureFetch as unknown as typeof globalThis.fetch, db });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/swh-callback",
      hmac_secret: HMAC_SECRET,
      review_id: reviewId,
      decision: "approved",
      decided_at: "2026-05-25T10:00:00.000Z",
    });

    expect(captureFetch).toHaveBeenCalledOnce();
    expect(capturedHeaders).toBeDefined();
    expect(capturedBody).toBeDefined();

    // All three SWH headers must be present
    expect(capturedHeaders!["webhook-id"]).toBeDefined();
    expect(capturedHeaders!["webhook-timestamp"]).toBeDefined();
    expect(capturedHeaders!["webhook-signature"]).toBeDefined();

    // webhook-signature must cryptographically verify against the known secret + captured body
    const valid = verifySwhSignature({
      webhookId: capturedHeaders!["webhook-id"],
      webhookTimestamp: capturedHeaders!["webhook-timestamp"],
      webhookSignature: capturedHeaders!["webhook-signature"],
      body: capturedBody!,
      secrets: [HMAC_SECRET],
      toleranceSeconds: Infinity, // test environment; not checking clock freshness
    });
    expect(valid).toBe(true);
  });

  it("outbound delivery X-Webhook-Event header equals the caller-supplied event type", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    const captureFetch = vi.fn(async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedHeaders = opts?.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    });

    const ws = new WebhookService({ fetch: captureFetch as unknown as typeof globalThis.fetch, db });

    await ws.sendRetry({
      callback_url: "https://agent.example.com/swh-callback-retry",
      hmac_secret: HMAC_SECRET,
      review_id: reviewId,
      feedback: "needs more detail",
    });

    expect(capturedHeaders!["X-Webhook-Event"]).toBe("review.retried");
  });
});
