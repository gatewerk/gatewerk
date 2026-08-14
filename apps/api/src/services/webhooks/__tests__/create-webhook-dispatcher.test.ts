import { describe, it, expect } from "vitest";
import { createWebhookDispatcher } from "../index";
import { WebhookService } from "../../webhooks";

describe("createWebhookDispatcher factory", () => {
  it("returns PgBossWebhookDispatcher by default (standalone mode)", async () => {
    const service = new WebhookService();
    const dispatcher = await createWebhookDispatcher({ mode: "standalone", webhookService: service });
    // signPayload is synchronous — exercise it to confirm we got a real adapter
    const sig = dispatcher.signPayload({ x: 1 }, "secret"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — factory-test fixture, not a production secret
    expect(sig.v1).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig.v2).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(sig.swh).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
  });

  it("falls back to PgBossWebhookDispatcher when mode=cloud but HOOKDECK_API_KEY is missing", async () => {
    const service = new WebhookService();
    const dispatcher = await createWebhookDispatcher({
      mode: "cloud",
      hookdeckApiKey: undefined,
      webhookService: service,
    });
    const sig = dispatcher.signPayload({ x: 1 }, "secret"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — factory-test fixture, not a production secret
    expect(sig.v1).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sig.v2).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(sig.swh).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
  });

  it("throws when called without webhookService AND without db (silent footgun → loud failure)", async () => {
    await expect(createWebhookDispatcher({ mode: "standalone" })).rejects.toThrow(
      /requires either .*webhookService.* or .*db/,
    );
  });
});
