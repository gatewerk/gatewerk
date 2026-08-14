/**
 * Pure-logic tests for the webhooks form helpers. No DOM render — web-next
 * has no React render harness by design (see Settings.test.tsx header).
 */
import { describe, it, expect } from "vitest";
import type { Webhook } from "@gatewerk/web-core/api/webhooks";
import {
  emptyWebhookForm,
  eventsMetaLine,
  formToCreateBody,
  formToTestBody,
  formToUpdateBody,
  testToastMessage,
  webhookToForm,
} from "./webhooks-logic";

const baseWebhook: Webhook = {
  id: "wh_1",
  project_id: "proj_1",
  name: "Slack notifications",
  webhook_url: "https://hooks.slack.com/services/T/B/X",
  events: ["review.created", "review.decided"],
  headers: null,
  is_active: true,
  type: "slack",
  created_at: "2026-08-01T00:00:00.000Z",
};

describe("emptyWebhookForm", () => {
  it("defaults to a blank generic form with no events or headers", () => {
    const form = emptyWebhookForm();
    expect(form.type).toBe("generic");
    expect(form.events).toEqual([]);
    expect(form.headers).toEqual([]);
  });
});

describe("webhookToForm round trip", () => {
  it("maps a webhook with no headers to an empty header list", () => {
    const form = webhookToForm(baseWebhook);
    expect(form.headers).toEqual([]);
    expect(form.webhookUrl).toBe(baseWebhook.webhook_url);
    expect(form.events).toEqual(["review.created", "review.decided"]);
  });

  it("expands a headers object into key/value rows", () => {
    const form = webhookToForm({ ...baseWebhook, headers: { "X-Custom": "abc" } });
    expect(form.headers).toEqual([{ key: "X-Custom", value: "abc" }]);
  });
});

describe("payload builders", () => {
  it("create body omits headers when every row is blank", () => {
    const body = formToCreateBody({
      ...emptyWebhookForm(),
      name: "n",
      webhookUrl: "https://x",
      events: ["review.created"],
    });
    expect(body.headers).toBeUndefined();
  });

  it("create body drops rows with an empty key", () => {
    const body = formToCreateBody({
      ...emptyWebhookForm(),
      name: "n",
      webhookUrl: "https://x",
      events: ["review.created"],
      headers: [
        { key: "", value: "orphan" },
        { key: "X-Ok", value: "1" },
      ],
    });
    expect(body.headers).toEqual({ "X-Ok": "1" });
  });

  it("update body nulls headers instead of omitting them when cleared", () => {
    const body = formToUpdateBody({
      ...emptyWebhookForm(),
      name: "n",
      webhookUrl: "https://x",
      events: ["review.created"],
    });
    expect(body.headers).toBeNull();
  });
});

describe("formToTestBody", () => {
  it("carries the draft url, type and headers for a pre-save test", () => {
    const body = formToTestBody({ ...emptyWebhookForm(), webhookUrl: "https://x", type: "discord" });
    expect(body).toEqual({ webhook_url: "https://x", type: "discord", headers: undefined });
  });
});

describe("eventsMetaLine", () => {
  it("joins a single event with no suffix", () => {
    expect(eventsMetaLine(["review.created"])).toBe("review.created");
  });

  it("space separates the first two events with no suffix at exactly two", () => {
    expect(eventsMetaLine(["review.decided", "review.created"])).toBe("review.decided review.created");
  });

  it("shows the first two events plus a +N count beyond two", () => {
    expect(
      eventsMetaLine(["review.decided", "review.created", "review.expired", "review.retried", "review.vetoed"]),
    ).toBe("review.decided review.created +3");
  });

  it("returns an empty string for no events", () => {
    expect(eventsMetaLine([])).toBe("");
  });
});

describe("testToastMessage", () => {
  it("formats a successful delivery with status and latency", () => {
    const msg = testToastMessage({ ok: true, status: 200, status_text: "OK", response_preview: "", latency_ms: 123 });
    expect(msg).toEqual({ kind: "success", message: "Test sent · 200 OK in 123ms" });
  });

  it("formats a non-2xx response without latency", () => {
    const msg = testToastMessage({
      ok: false,
      status: 404,
      status_text: "Not Found",
      response_preview: "",
      latency_ms: 88,
    });
    expect(msg).toEqual({ kind: "error", message: "Test failed · 404 Not Found" });
  });

  it("formats an unreachable endpoint (status 0) with just the status text", () => {
    const msg = testToastMessage({
      ok: false,
      status: 0,
      status_text: "Failed to fetch",
      response_preview: "",
      latency_ms: 0,
    });
    expect(msg).toEqual({ kind: "error", message: "Test failed · Failed to fetch" });
  });
});
