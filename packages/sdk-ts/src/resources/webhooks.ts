import { createHmac, timingSafeEqual } from "crypto";

export class WebhooksResource {
  /**
   * Verify a webhook signature from the X-Webhook-Signature header.
   * Returns the parsed payload if valid, throws if invalid.
   *
   * Header format: `sha256=<hex>` where hex is HMAC-SHA256(secret, rawBody).
   * No timestamp — replay protection is not needed until webhooks accept
   * third-party publishers. Receivers that want dedupe should use the
   * X-Webhook-Id header as an idempotency key.
   */
  verify(rawBody: string, signatureHeader: string, secret: string): Record<string, unknown> {
    const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader);
    if (!match) {
      throw new Error("Invalid signature header format");
    }
    const provided = match[1];

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("Webhook signature verification failed");
    }

    return JSON.parse(rawBody);
  }
}
