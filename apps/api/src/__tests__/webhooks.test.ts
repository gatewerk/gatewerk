import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { reviews, webhookDeliveries } from "@gatewerk/db/src/schema/index";
import { VERSION, generateId } from "@gatewerk/shared";
import { WebhookService } from "../services/webhooks";
import { createTestDb, seedTestProject } from "./helpers/test-db";

describe("WebhookService", () => {
  it("sendDecision POSTs payload with Gatewerk webhook headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: "gw_rev_001",
      decision: "approved",
      decided_at: "2026-03-09T12:00:00.000Z",
      feedback: "Looks good",
      reviewer: "alice@example.com",
      request_id: "req_abc123def456",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent.example.com/callback");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    // Standard Gatewerk webhook header set.
    expect(opts.headers["User-Agent"]).toBe(`Gatewerk/${VERSION}`);
    expect(opts.headers["X-Webhook-Event"]).toBe("review.decided");
    expect(opts.headers["X-Webhook-Id"]).toMatch(/^gw_del_[A-Za-z0-9_-]+$/);
    expect(opts.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // v2 signature carries the timestamp + replay-safe HMAC.
    expect(opts.headers["X-Webhook-Signature-V2"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(opts.headers["X-Request-Id"]).toBe("req_abc123def456");

    // Body should NOT contain signature
    const body = JSON.parse(opts.body);
    expect(body.signature).toBeUndefined();
    expect(body.review_id).toBe("gw_rev_001");
    expect(body.decision).toBe("approved");
    expect(body.feedback).toBe("Looks good");
    expect(body.reviewer).toBe("alice@example.com");
  });

  it("HMAC v1 is computed as sha256(body) with the project secret", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    const hmacSecret = "my-secret-key";

    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: hmacSecret,
      review_id: "gw_rev_002",
      decision: "rejected",
      decided_at: "2026-03-09T13:00:00.000Z",
    });

    const [, opts] = mockFetch.mock.calls[0];
    const sigHeader = opts.headers["X-Webhook-Signature"];
    const bodyStr = opts.body;

    const hex = sigHeader.replace(/^sha256=/, "");
    // Test-only secret used to verify the service computed the same HMAC — not a real credential.
    const expected = createHmac("sha256", hmacSecret).update(bodyStr).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key

    expect(hex).toBe(expected);
  });

  it("HMAC v2 binds a fresh timestamp to the body (replay protection)", async () => {
    // Regression lock for launch-audit H-2. The v2 envelope has three
    // load-bearing properties that the commit message claims are tested:
    //   1. Timestamp freshness — `t` must be within the request window.
    //   2. HMAC correctness — hex must equal HMAC(`${t}.${body}`, secret).
    //   3. Timestamp binding — hex must NOT equal HMAC(body, secret) alone,
    //      proving the timestamp actually mixes into the signature (a
    //      refactor that emitted a body-only HMAC with a `t=` prefix would
    //      silently break replay protection without this assertion).
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    const hmacSecret = "my-secret-key";

    const before = Math.floor(Date.now() / 1000);
    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: hmacSecret,
      review_id: "gw_rev_v2",
      decision: "approved",
      decided_at: "2026-04-21T00:00:00.000Z",
    });
    const after = Math.floor(Date.now() / 1000);

    const [, opts] = mockFetch.mock.calls[0];
    const v2Header = opts.headers["X-Webhook-Signature-V2"] as string;
    const bodyStr = opts.body as string;

    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(v2Header);
    expect(match).not.toBeNull();
    const ts = Number(match![1]);
    const hex = match![2];

    // Property 1: freshness.
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);

    // Property 2: HMAC correctness against `${ts}.${body}`.
    const tsBoundHex = createHmac("sha256", hmacSecret).update(`${ts}.${bodyStr}`).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(hex).toBe(tsBoundHex);

    // Property 3: timestamp is bound — body-only HMAC must differ from v2.
    const bodyOnlyHex = createHmac("sha256", hmacSecret).update(bodyStr).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(hex).not.toBe(bodyOnlyHex);

    // Documents the two-signature contract: v1 header carries exactly the
    // body-only hex, v2 header carries the timestamp-bound hex.
    expect(opts.headers["X-Webhook-Signature"]).toBe(`sha256=${bodyOnlyHex}`);
  });

  it("sendRetry POSTs retry payload with review.retried event header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendRetry({
      callback_url: "https://agent.example.com/retry",
      hmac_secret: "secret123",
      review_id: "gw_rev_003",
      feedback: "Too vague",
      prompt_edit: "Add more details",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent.example.com/retry");

    expect(opts.headers["X-Webhook-Event"]).toBe("review.retried");
    expect(opts.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(opts.headers["X-Webhook-Signature-V2"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(opts.headers["X-Webhook-Id"]).toBeDefined();

    const body = JSON.parse(opts.body);
    expect(body.review_id).toBe("gw_rev_003");
    expect(body.action).toBe("retry");
    expect(body.feedback).toBe("Too vague");
  });

  it("omits X-Request-Id when no request_id is provided (worker context)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendExpiry({
      callback_url: "https://agent.example.com/expire",
      hmac_secret: "secret",
      review_id: "gw_rev_004",
      timeout_action: "expire",
      expired_at: "2026-03-09T14:00:00.000Z",
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-Webhook-Event"]).toBe("review.expired");
    expect(opts.headers["X-Request-Id"]).toBeUndefined();
  });

  it("sendAssignmentEscalated POSTs ladder promotion payload with HMAC headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendAssignmentEscalated({
      callback_url: "https://agent.example.com/escalate",
      hmac_secret: "secret-ladder",
      review_id: "gw_rev_ladder_1",
      previous_assignee: "alice",
      new_assignee: "manager",
      ladder_index: 1,
      escalated_at: "2026-04-23T12:00:00.000Z",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent.example.com/escalate");
    expect(opts.method).toBe("POST");

    // Discriminator + headers match the Gatewerk webhook envelope contract.
    expect(opts.headers["X-Webhook-Event"]).toBe("assignment.escalated");
    expect(opts.headers["X-Webhook-Id"]).toMatch(/^gw_del_[A-Za-z0-9_-]+$/);
    expect(opts.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(opts.headers["X-Webhook-Signature-V2"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      type: "assignment.escalated",
      review_id: "gw_rev_ladder_1",
      previous_assignee: "alice",
      new_assignee: "manager",
      ladder_index: 1,
      escalated_at: "2026-04-23T12:00:00.000Z",
    });
  });

  it("sendAssignmentEscalated HMAC v1 is sha256(body, secret)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    const hmacSecret = "ladder-secret-v1";

    await ws.sendAssignmentEscalated({
      callback_url: "https://agent.example.com/escalate",
      hmac_secret: hmacSecret,
      review_id: "gw_rev_ladder_v1",
      previous_assignee: "alice",
      new_assignee: "admin",
      ladder_index: 2,
      escalated_at: "2026-04-23T13:00:00.000Z",
    });

    const [, opts] = mockFetch.mock.calls[0];
    const sigHeader = opts.headers["X-Webhook-Signature"];
    const bodyStr = opts.body;

    const hex = sigHeader.replace(/^sha256=/, "");
    // Test-only secret used to verify the service computed the same HMAC — not a real credential.
    const expected = createHmac("sha256", hmacSecret).update(bodyStr).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(hex).toBe(expected);
  });

  it("sendAssignmentEscalated includes optional metadata in payload when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendAssignmentEscalated({
      callback_url: "https://agent.example.com/escalate",
      hmac_secret: "secret",
      review_id: "gw_rev_ladder_meta",
      previous_assignee: "alice",
      new_assignee: "manager",
      ladder_index: 1,
      escalated_at: "2026-04-23T14:00:00.000Z",
      metadata: { ladder_step_id: "gw_step_abc", reason: "timeout" },
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.metadata).toEqual({ ladder_step_id: "gw_step_abc", reason: "timeout" });
  });
});

describe("WebhookService.sendCustom event_type validation", () => {
  function makeServiceForValidationTest(): WebhookService {
    // No db injected — the event_type validator fires BEFORE the no-db throw,
    // so this is sufficient for all validation-rejection tests.
    return new WebhookService({ fetch: vi.fn() });
  }

  const baseOpts = {
    callback_url: "https://example.com/hook",
    hmac_secret: "test-secret", // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key — test fixture for event_type validator, not a production secret
    review_id: "rev_validate",
    payload: { x: 1 },
  };

  it("rejects empty event_type", async () => {
    const svc = makeServiceForValidationTest();
    await expect(svc.sendCustom({ ...baseOpts, event_type: "" })).rejects.toThrow(/invalid event_type/);
  });

  it("rejects event_type containing CRLF (HTTP header injection)", async () => {
    const svc = makeServiceForValidationTest();
    await expect(svc.sendCustom({ ...baseOpts, event_type: "\r\nX-Injected: yes" })).rejects.toThrow(/invalid event_type/);
  });

  it("rejects event_type longer than 64 chars", async () => {
    const svc = makeServiceForValidationTest();
    await expect(svc.sendCustom({ ...baseOpts, event_type: "x".repeat(65) })).rejects.toThrow(/invalid event_type/);
  });

  it("rejects event_type containing whitespace", async () => {
    const svc = makeServiceForValidationTest();
    await expect(svc.sendCustom({ ...baseOpts, event_type: "foo bar" })).rejects.toThrow(/invalid event_type/);
  });

  // Task 2: frozen decision-callback contract — iteration_count threading.
  it("sendDecision includes iteration_count in payload when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret",
      review_id: "gw_rev_iter",
      decision: "approved",
      decided_at: "2026-06-29T00:00:00.000Z",
      iteration_count: 2,
    });
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.iteration_count).toBe(2);
  });

  it("sendDecision omits iteration_count from payload when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret",
      review_id: "gw_rev_no_iter",
      decision: "rejected",
      decided_at: "2026-06-29T00:00:00.000Z",
    });
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.iteration_count).toBeUndefined();
  });

  it("auto-approve callback carries iteration_count alongside auto_approved (auto-approve-on-retry guard)", async () => {
    // Mirrors the routes/reviews/crud.ts auto-approve sendDecision call. A
    // present auto-approve path is always version 1 (field dropped), but the
    // caller now passes iteration_count explicitly so a future
    // auto-approve-on-retry (version > 1) emits the correct value. This asserts
    // the two fields coexist and the derived value flows through.
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });
    await ws.sendDecision({
      chain_run_id: null,
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret",
      review_id: "gw_rev_auto",
      decision: "approved",
      decided_at: "2026-06-29T00:00:00.000Z",
      approved_value: { content: "auto" },
      was_edited: false,
      auto_approved: true,
      action_value: "auto_approve",
      action_label: "Auto-approved",
      // Hypothetical auto-approve-on-retry: current_version=3 → iteration_count=2.
      iteration_count: 3 > 1 ? 3 - 1 : undefined,
    });
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.auto_approved).toBe(true);
    expect(body.iteration_count).toBe(2);
  });

  it("accepts canonical event_type values (review.decided, chain.completed, custom.event_v1)", async () => {
    const svc = makeServiceForValidationTest();
    // These should pass the regex; they will then fail with the no-db throw
    // (or proceed to delivery). We assert ONLY that they don't throw with
    // the "invalid event_type" message.
    for (const eventType of ["review.decided", "chain.completed", "custom.event_v1"]) {
      try {
        await svc.sendCustom({ ...baseOpts, event_type: eventType });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toMatch(/invalid event_type/);
      }
    }
  });
});

describe("WebhookService.sendSentBack + sendQuestionsRaised (Plan 6 C1)", () => {
  it("sendSentBack POSTs with type=review.sent_back, NOT review.decided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendSentBack({
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret-sb",
      review_id: "gw_rev_sentback_01",
      recipient_label: "Acme Reviewer",
      decline_reason: "Out of office until next week",
      reverted_at: "2026-06-27T10:00:00.000Z",
      request_id: "req_sentback",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent.example.com/callback");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body);
    // Must be "review.sent_back" — never "review.decided"
    expect(body.type).toBe("review.sent_back");
    expect(body.type).not.toBe("review.decided");
    expect(body.review_id).toBe("gw_rev_sentback_01");
    expect(body.recipient_label).toBe("Acme Reviewer");
    expect(body.decline_reason).toBe("Out of office until next week");
    expect(body.reverted_at).toBe("2026-06-27T10:00:00.000Z");

    expect(opts.headers["X-Webhook-Event"]).toBe("review.sent_back");
    expect(opts.headers["X-Request-Id"]).toBe("req_sentback");
  });

  it("sendSentBack omits decline_reason when null/absent", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendSentBack({
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret-sb",
      review_id: "gw_rev_sentback_02",
      recipient_label: "Acme Reviewer",
      reverted_at: "2026-06-27T10:00:00.000Z",
    });

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.type).toBe("review.sent_back");
    expect(body.decline_reason).toBeUndefined();
  });

  it("sendQuestionsRaised POSTs with type=review.questions_raised, NOT review.decided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ fetch: mockFetch });

    await ws.sendQuestionsRaised({
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret-qr",
      review_id: "gw_rev_qr_01",
      recipient_label: "Acme Reviewer",
      question_text: "Could you clarify the rollout timeline?",
      reverted_at: "2026-06-27T11:00:00.000Z",
      request_id: "req_qr",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent.example.com/callback");

    const body = JSON.parse(opts.body);
    // Must be "review.questions_raised" — never "review.decided"
    expect(body.type).toBe("review.questions_raised");
    expect(body.type).not.toBe("review.decided");
    expect(body.review_id).toBe("gw_rev_qr_01");
    expect(body.recipient_label).toBe("Acme Reviewer");
    expect(body.question_text).toBe("Could you clarify the rollout timeline?");
    expect(body.reverted_at).toBe("2026-06-27T11:00:00.000Z");

    expect(opts.headers["X-Webhook-Event"]).toBe("review.questions_raised");
    expect(opts.headers["X-Request-Id"]).toBe("req_qr");
  });
});

// C1 (charter §5.1): review.decided is not a chain event.
//
// Under the route model every step reviews the same request against the same
// template, so step 1's approval webhook is shape-identical to the final
// authorization — this payload carries no template, no chain id and no step
// index. An agent keying on review.decided would act after the junior's yes
// and before the senior ever looked. The distinction is made by NOT sending
// it: a chain announces each step with chain.step_decided and authorizes with
// chain.completed.
describe("WebhookService.sendDecision — chain suppression", () => {
  async function withReview() {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const reviewId = generateId("review");
    await db.insert(reviews).values({
      id: reviewId,
      project_id: seed.project.id,
      template_slug: "tpl",
      payload: {},
      status: "decided",
    });
    return { db, reviewId };
  }

  it("sends nothing and records a suppressed delivery when the review is chain-attached", async () => {
    const { db, reviewId } = await withReview();
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ db, fetch: mockFetch });

    await ws.sendDecision({
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: reviewId,
      decision: "approved",
      decided_at: "2026-08-06T12:00:00.000Z",
      chain_run_id: "gw_chain_abc",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("review.decided");
    expect(rows[0].status).toBe("suppressed");
  });

  it("dispatches normally when the review is not chain-attached", async () => {
    const { db, reviewId } = await withReview();
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ws = new WebhookService({ db, fetch: mockFetch });

    await ws.sendDecision({
      callback_url: "https://agent.example.com/callback",
      hmac_secret: "secret123",
      review_id: reviewId,
      decision: "approved",
      decided_at: "2026-08-06T12:00:00.000Z",
      chain_run_id: null,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // The frozen v1 payload is unchanged for a non-chain review: no chain key
    // leaked in while adding the suppression.
    expect(Object.keys(body).sort()).toEqual(
      ["decided_at", "decision", "review_id", "type", "was_edited"].sort(),
    );
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.review_id, reviewId));
    expect(rows[0].status).not.toBe("suppressed");
  });
});
