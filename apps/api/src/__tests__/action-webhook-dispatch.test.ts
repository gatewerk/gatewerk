// Tests for the wh.* outbound dispatcher. Pure-fn-testable by mocking
// WebhookService — verifies that each action kind maps to the correct
// wh.* method calls per spec §9.2 dual-fire.

import { describe, it, expect, vi } from "vitest";
import { dispatchActionWebhooks } from "../services/reviews/action-webhook-dispatch";
import type { WebhookOutbound } from "../services/reviews/actions";
import type { WebhookService } from "../services/webhooks";

function makeFakeWh() {
  return {
    sendActionTaken: vi.fn(() => Promise.resolve()),
    sendDecision: vi.fn(() => Promise.resolve()),
    sendRetry: vi.fn(() => Promise.resolve()),
    sendCustomIteration: vi.fn(() => Promise.resolve()),
  };
}

const baseInput = {
  callbackUrl: "https://agent.example.com/cb",
  hmacSecret: "test-secret",
  reviewId: "gw_rev_test",
  requestId: "req_abc",
};

const ACTION_TAKEN_PAYLOAD: Record<string, unknown> = {
  event: "review.action_taken",
  review_id: "gw_rev_test",
  action: { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
};

describe("dispatchActionWebhooks", () => {
  it("decision approve → sendActionTaken + sendDecision(decision=approved)", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: ACTION_TAKEN_PAYLOAD },
      { event: "review.decided", payload: { event: "review.decided", decision: "approved" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      decision: "approved",
      decidedAt: new Date("2026-05-06T00:00:00.000Z"),
      decidedBy: "reviewer:alice@example.com",
      approvedValue: { title: "go" },
      feedback: null,
      editedPayload: null,
      actionId: "approve",
      actionLabel: "Approve",
    });
    await Promise.all(promises);

    expect(wh.sendActionTaken).toHaveBeenCalledTimes(1);
    expect(wh.sendActionTaken).toHaveBeenCalledWith(
      expect.objectContaining({
        callback_url: baseInput.callbackUrl,
        hmac_secret: baseInput.hmacSecret,
        review_id: baseInput.reviewId,
        payload: ACTION_TAKEN_PAYLOAD,
      }),
    );

    expect(wh.sendDecision).toHaveBeenCalledTimes(1);
    expect(wh.sendDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        decided_at: "2026-05-06T00:00:00.000Z",
        reviewer: "reviewer:alice@example.com",
        approved_value: { title: "go" },
        was_edited: false,
        action_value: "approve",
        action_label: "Approve",
      }),
    );

    expect(wh.sendRetry).not.toHaveBeenCalled();
    expect(wh.sendCustomIteration).not.toHaveBeenCalled();
  });

  it("decision reject with edits → sendActionTaken + sendDecision(decision=rejected, was_edited=true)", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
      { event: "review.decided", payload: { event: "review.decided" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      decision: "rejected",
      decidedAt: new Date("2026-05-06T00:00:00.000Z"),
      decidedBy: "reviewer:alice@example.com",
      editedPayload: { reason: "off-brand" },
      feedback: "Tone is too informal",
      actionId: "reject",
      actionLabel: "Reject",
    });
    await Promise.all(promises);

    expect(wh.sendDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "rejected",
        edited_payload: { reason: "off-brand" },
        was_edited: true,
        feedback: "Tone is too informal",
      }),
    );
  });

  it("review.decided event passes iterationCount to sendDecision as iteration_count", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.decided", payload: { event: "review.decided", decision: "approved" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      decision: "approved",
      decidedAt: new Date("2026-06-29T00:00:00.000Z"),
      iterationCount: 2,
    });
    await Promise.all(promises);

    expect(wh.sendDecision).toHaveBeenCalledWith(
      expect.objectContaining({ iteration_count: 2 }),
    );
  });

  it("review.decided omits iteration_count when iterationCount not provided", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.decided", payload: { event: "review.decided", decision: "rejected" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      decision: "rejected",
      decidedAt: new Date("2026-06-29T00:00:00.000Z"),
    });
    await Promise.all(promises);

    expect(wh.sendDecision).toHaveBeenCalledWith(
      expect.not.objectContaining({ iteration_count: expect.anything() }),
    );
  });

  it("iteration request_changes (legacy preset) → sendActionTaken + sendRetry", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
      { event: "review.retried", payload: { event: "review.retried" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      feedback: "Tone is too informal",
    });
    await Promise.all(promises);

    expect(wh.sendActionTaken).toHaveBeenCalledTimes(1);
    expect(wh.sendRetry).toHaveBeenCalledTimes(1);
    expect(wh.sendRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        callback_url: baseInput.callbackUrl,
        review_id: baseInput.reviewId,
        feedback: "Tone is too informal",
      }),
    );
    expect(wh.sendDecision).not.toHaveBeenCalled();
    expect(wh.sendCustomIteration).not.toHaveBeenCalled();
  });

  it("iteration custom action with webhook_event → sendActionTaken + sendCustomIteration(eventName=review.escalated)", async () => {
    const wh = makeFakeWh();
    const customPayload = {
      event: "review.escalated",
      review_id: "gw_rev_test",
      action_id: "escalate",
      feedback: "Above threshold",
    };
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
      { event: "review.escalated", payload: customPayload },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      feedback: "Above threshold",
    });
    await Promise.all(promises);

    expect(wh.sendCustomIteration).toHaveBeenCalledTimes(1);
    expect(wh.sendCustomIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "review.escalated",
        payload: customPayload,
      }),
    );
    expect(wh.sendRetry).not.toHaveBeenCalled();
  });

  it("iteration custom action without webhook_event → sendActionTaken + sendCustomIteration(eventName=review.iteration_<id>)", async () => {
    const wh = makeFakeWh();
    const customPayload = {
      event: "review.iteration_escalate_default",
      review_id: "gw_rev_test",
      action_id: "escalate_default",
    };
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
      { event: "review.iteration_escalate_default", payload: customPayload },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
    });
    await Promise.all(promises);

    expect(wh.sendCustomIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "review.iteration_escalate_default",
      }),
    );
  });

  it("side_effect → sendActionTaken only, no legacy compat", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
    ];

    const promises = dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
    });
    await Promise.all(promises);

    expect(wh.sendActionTaken).toHaveBeenCalledTimes(1);
    expect(wh.sendDecision).not.toHaveBeenCalled();
    expect(wh.sendRetry).not.toHaveBeenCalled();
    expect(wh.sendCustomIteration).not.toHaveBeenCalled();
  });

  it("propagates request_id to every wh.* call for X-Request-Id correlation", async () => {
    const wh = makeFakeWh();
    const webhooks: WebhookOutbound[] = [
      { event: "review.action_taken", payload: { event: "review.action_taken" } },
      { event: "review.decided", payload: { event: "review.decided" } },
    ];

    dispatchActionWebhooks({
      chainRunId: null,
      ...baseInput,
      wh: wh as unknown as WebhookService,
      webhooks,
      decision: "approved",
      decidedAt: new Date("2026-05-06T00:00:00.000Z"),
    });

    expect(wh.sendActionTaken).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: baseInput.requestId }),
    );
    expect(wh.sendDecision).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: baseInput.requestId }),
    );
  });
});
