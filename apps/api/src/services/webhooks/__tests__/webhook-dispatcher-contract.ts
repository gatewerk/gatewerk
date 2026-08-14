import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import type { WebhookDispatcher, WebhookEvent } from "../webhook-dispatcher";
import { computeSwhSignature } from "../standard-webhooks";

/**
 * Shared behavioural contract for all WebhookDispatcher implementations.
 * Import this factory in adapter-specific test files and invoke with a
 * factory that returns a fresh adapter instance.
 *
 * Usage:
 *   import { webhookDispatcherContract } from ".../webhook-dispatcher-contract";
 *   webhookDispatcherContract("pg-boss", () => new PgBossWebhookDispatcher(...));
 */
export function webhookDispatcherContract(
  adapterName: string,
  factory: (opts?: { mode?: "broken" }) => WebhookDispatcher,
): void {
  describe(`WebhookDispatcher contract — ${adapterName}`, () => {
    function validEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
      return {
        deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
        eventType: "review.decided",
        url: "https://example.com/webhook",
        payload: { type: "review.decided", review_id: "rev_test_001" },
        hmacSecret: "test-secret-xyz", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — contract test fixture, not a production secret
        reviewId: "rev_test_001",
        ...overrides,
      };
    }

    it("dispatch() returns a non-empty DispatchId", async () => {
      const dispatcher = factory();
      const id = await dispatcher.dispatch(validEvent());
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("verifyDeliveryStatus() returns a known state for a dispatched event", async () => {
      const dispatcher = factory();
      const event = validEvent();
      const id = await dispatcher.dispatch(event);
      const status = await dispatcher.verifyDeliveryStatus(id);
      expect(["pending", "delivered", "failed", "unknown"]).toContain(status.state);
    });

    it("verifyDeliveryStatus() returns unknown for a non-existent id", async () => {
      const dispatcher = factory();
      const status = await dispatcher.verifyDeliveryStatus("non-existent-id-xyz");
      expect(status.state).toBe("unknown");
    });

    it("signPayload() produces cryptographically correct signatures (byte-parity vs node:crypto)", () => {
      const dispatcher = factory();
      const payload = { type: "review.decided", review_id: "rev_abc" };
      const secret = "test-secret-fixed"; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — contract-test fixture, not a production secret
      const ts = 1_700_000_000;
      const sig = dispatcher.signPayload(payload, secret, ts);

      const body = JSON.stringify(payload);

      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — `secret` is the test fixture declared above, not a production secret; this call asserts the dispatcher output matches node:crypto byte-for-byte
      const expectedV1 = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      expect(sig.v1).toBe(expectedV1);

      // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — same fixture; v2 replay-safe format byte-parity check
      const expectedV2 = `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
      expect(sig.v2).toBe(expectedV2);

      const expectedSwhRaw = computeSwhSignature("sign-payload-preview", ts, body, secret);
      expect(sig.swh).toBe(`v1,${expectedSwhRaw}`);
    });

    it("dispatch() rejects when underlying transport throws", async () => {
      const dispatcher = factory({ mode: "broken" });
      const event: WebhookEvent = {
        deliveryId: "del_broken",
        eventType: "review.decided",
        url: "https://example.com/hook",
        payload: { x: 1 },
        hmacSecret: "secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — contract-test fixture, not a production secret
        reviewId: "rev_broken",
      };
      await expect(dispatcher.dispatch(event)).rejects.toThrow();
    });

    it("signPayload() uses provided timestamp in v2 and swh", () => {
      const dispatcher = factory();
      const ts = 1_700_000_000;
      const sig = dispatcher.signPayload({ hello: "world" }, "my-secret", ts); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — contract test fixture, not a production secret
      expect(sig.timestamp).toBe(ts);
      expect(sig.v2).toMatch(new RegExp(`^t=${ts},v1=`));
    });
  });
}
