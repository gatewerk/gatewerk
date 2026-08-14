import { describe, it, expect, vi } from "vitest";
import { PgBossWebhookDispatcher } from "../pg-boss-webhook-dispatcher";
import { webhookDispatcherContract } from "./webhook-dispatcher-contract";
import type { WebhookService } from "../../webhooks";

// Stub WebhookService — the contract tests only exercise the adapter surface.
// vi.fn() per method gives us the spy hooks we need without instantiating
// the real service (which would require DB + pg-boss + fetch).
const mockWebhookService = {
  sendCustom: vi.fn(async () => ({ deliveryId: "del_test_minted" })),
  sendActionTaken: vi.fn(async () => {}),
  sendDecision: vi.fn(async () => {}),
  sendRetry: vi.fn(async () => {}),
  sendExpiry: vi.fn(async () => {}),
  sendChainCompleted: vi.fn(async () => {}),
  sendChainRejected: vi.fn(async () => {}),
  sendChainNextStepReady: vi.fn(async () => {}),
  sendChainStepRejected: vi.fn(async () => {}),
  sendAssignmentEscalated: vi.fn(async () => {}),
  sendCustomIteration: vi.fn(async () => {}),
  retryDelivery: vi.fn(async () => {}),
};

// Cast to bypass strict service typing — the stub intentionally omits internal
// WebhookService constructor params (db, boss, etc.) not needed by the adapter.
const mockSvc = mockWebhookService as ReturnType<typeof Object.assign>;

// Run shared contract (no db → verifyDeliveryStatus returns "unknown")
webhookDispatcherContract(
  "pg-boss",
  (opts) => {
    if (opts?.mode === "broken") {
      const broken = { sendCustom: vi.fn(async () => { throw new Error("transport_broken"); }) };
      return new PgBossWebhookDispatcher(broken as unknown as WebhookService);
    }
    return new PgBossWebhookDispatcher(mockSvc);
  },
);

describe("PgBossWebhookDispatcher — additional unit cases", () => {
  it("dispatch() calls sendCustom on the underlying service", async () => {
    mockWebhookService.sendCustom.mockClear();
    const dispatcher = new PgBossWebhookDispatcher(mockSvc);
    await dispatcher.dispatch({
      deliveryId: "del_001",
      eventType: "review.decided",
      url: "https://example.com/hook",
      payload: { type: "review.decided" },
      hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — unit test fixture, not a production secret
      reviewId: "rev_test_001",
    });
    expect(mockWebhookService.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ callback_url: "https://example.com/hook" }),
    );
  });

  it("dispatch() passes event_type as caller-supplied (no synthetic wrapper)", async () => {
    mockWebhookService.sendCustom.mockClear();
    const dispatcher = new PgBossWebhookDispatcher(mockSvc);
    await dispatcher.dispatch({
      deliveryId: "del_002",
      eventType: "chain.completed",
      url: "https://example.com/hook",
      payload: { original: "data" },
      hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — unit test fixture, not a production secret
      reviewId: "rev_test_002",
    });
    expect(mockWebhookService.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "chain.completed" }),
    );
  });

  it("dispatch() calls sendCustom with caller-supplied event_type (not hardcoded)", async () => {
    mockWebhookService.sendCustom.mockClear();
    const dispatcher = new PgBossWebhookDispatcher(mockSvc);
    await dispatcher.dispatch({
      deliveryId: "del_event_type",
      eventType: "chain.completed",
      url: "https://example.com/hook",
      payload: { x: 1 },
      hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — unit test fixture, not a production secret
      reviewId: "rev_event_type",
    });
    expect(mockWebhookService.sendCustom).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "chain.completed" }),
    );
  });

  it("dispatch() returns the minted DispatchId from sendCustom (NOT caller-supplied event.deliveryId)", async () => {
    mockWebhookService.sendCustom.mockClear();
    mockWebhookService.sendCustom.mockResolvedValueOnce({ deliveryId: "del_minted_xyz" });
    const dispatcher = new PgBossWebhookDispatcher(mockSvc);
    const id = await dispatcher.dispatch({
      deliveryId: "del_caller_supplied",
      eventType: "review.decided",
      url: "https://example.com/hook",
      payload: { x: 1 },
      hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — unit test fixture, not a production secret
      reviewId: "rev_minted",
    });
    expect(id).toBe("del_minted_xyz");
    expect(id).not.toBe("del_caller_supplied");
  });

  it("dispatch() throws when reviewId is missing", async () => {
    const dispatcher = new PgBossWebhookDispatcher(mockSvc);
    await expect(
      dispatcher.dispatch({
        deliveryId: "del_no_review",
        eventType: "review.decided",
        url: "https://example.com/hook",
        payload: { x: 1 },
        hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — unit test fixture, not a production secret
        reviewId: "" as unknown as string, // bypass type-check; simulate runtime caller bug
      }),
    ).rejects.toThrow("reviewId is required");
  });
});
