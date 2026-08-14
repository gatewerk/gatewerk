import { describe, it, expect } from "vitest";
import {
  ReviewCreateBodySchema,
  ReviewDecideBodySchema,
  ReviewRetryBodySchema,
  ReviewUpdateVersionBodySchema,
  ReviewDraftBodySchema,
  ReviewListQuerySchema,
  ReviewBulkIdsBodySchema,
  ReviewNoteBodySchema,
  ReviewObjectSchema,
  ReviewListResponseSchema,
} from "@gatewerk/shared";

describe("reviews zod schemas", () => {
  describe("ReviewCreateBodySchema", () => {
    it("accepts minimal create body", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "my-template",
        payload: { content: "hi" },
      });
      expect(r.success).toBe(true);
    });

    it("accepts full create body", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "my-template",
        payload: { content: "hi" },
        callback_url: "https://example.com/hook",
        priority: "high",
        actions: ["approve", "reject"],
        confidence: 0.9,
        irreversibility: "reversible",
        assignee: "user@example.com",
        metadata: { source: "test" },
        timeout: { action: "auto_reject", seconds: 120 },
      });
      expect(r.success).toBe(true);
    });

    it("rejects missing template", () => {
      const r = ReviewCreateBodySchema.safeParse({ payload: {} });
      expect(r.success).toBe(false);
    });

    it("rejects invalid priority", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        priority: "huge",
      });
      expect(r.success).toBe(false);
    });

    it("rejects invalid callback_url", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        callback_url: "not-a-url",
      });
      expect(r.success).toBe(false);
    });

    it("rejects timeout seconds below 60", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        timeout: { action: "auto_reject", seconds: 30 },
      });
      expect(r.success).toBe(false);
    });

    it("accepts https trace_url", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        trace_url: "https://langfuse.cloud/traces/abc123",
      });
      expect(r.success).toBe(true);
    });

    it("rejects http trace_url", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        trace_url: "http://langfuse.cloud/traces/abc123",
      });
      expect(r.success).toBe(false);
    });

    it("rejects javascript: trace_url", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        trace_url: "javascript:alert(1)",
      });
      expect(r.success).toBe(false);
    });

    it("rejects data: trace_url", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        trace_url: "data:text/html,<h1>xss</h1>",
      });
      expect(r.success).toBe(false);
    });

    it("accepts max_iterations as a positive integer", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        max_iterations: 3,
      });
      expect(r.success).toBe(true);
    });

    it("rejects max_iterations of zero", () => {
      const r = ReviewCreateBodySchema.safeParse({
        template: "t",
        payload: {},
        max_iterations: 0,
      });
      expect(r.success).toBe(false);
    });
  });

  describe("ReviewDecideBodySchema", () => {
    it("accepts minimal decision", () => {
      const r = ReviewDecideBodySchema.safeParse({ decision: "approved" });
      expect(r.success).toBe(true);
    });

    it("accepts full decision", () => {
      const r = ReviewDecideBodySchema.safeParse({
        decision: "edited",
        feedback: "tweaked",
        edited_payload: { content: "new" },
        reviewer: "r@example.com",
        version: 2,
        action_value: "approve",
        action_label: "Approve",
      });
      expect(r.success).toBe(true);
    });

    it("rejects missing decision", () => {
      const r = ReviewDecideBodySchema.safeParse({ feedback: "x" });
      expect(r.success).toBe(false);
    });

    it("rejects invalid decision enum", () => {
      const r = ReviewDecideBodySchema.safeParse({ decision: "maybe" });
      expect(r.success).toBe(false);
    });

    it("rejects zero or negative version", () => {
      const r = ReviewDecideBodySchema.safeParse({ decision: "approved", version: 0 });
      expect(r.success).toBe(false);
    });
  });

  describe("ReviewRetryBodySchema", () => {
    it("requires non-empty feedback", () => {
      expect(ReviewRetryBodySchema.safeParse({ feedback: "fix this" }).success).toBe(true);
      expect(ReviewRetryBodySchema.safeParse({ feedback: "" }).success).toBe(false);
      expect(ReviewRetryBodySchema.safeParse({}).success).toBe(false);
    });
  });

  describe("ReviewUpdateVersionBodySchema", () => {
    it("accepts payload + positive version", () => {
      const r = ReviewUpdateVersionBodySchema.safeParse({
        payload: { a: 1 },
        version: 2,
      });
      expect(r.success).toBe(true);
    });

    it("rejects missing version", () => {
      const r = ReviewUpdateVersionBodySchema.safeParse({ payload: {} });
      expect(r.success).toBe(false);
    });
  });

  describe("ReviewDraftBodySchema", () => {
    it("requires object draft_payload", () => {
      expect(ReviewDraftBodySchema.safeParse({ draft_payload: { a: 1 } }).success).toBe(true);
      expect(ReviewDraftBodySchema.safeParse({ draft_payload: "string" }).success).toBe(false);
    });
  });

  describe("ReviewListQuerySchema", () => {
    it("coerces limit and offset from strings", () => {
      const r = ReviewListQuerySchema.safeParse({ limit: "25", offset: "50" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.limit).toBe(25);
        expect(r.data.offset).toBe(50);
      }
    });

    it("caps limit at 100", () => {
      const r = ReviewListQuerySchema.safeParse({ limit: "500" });
      expect(r.success).toBe(false);
    });

    it("validates status enum", () => {
      expect(ReviewListQuerySchema.safeParse({ status: "pending" }).success).toBe(true);
      expect(ReviewListQuerySchema.safeParse({ status: "unknown" }).success).toBe(false);
    });
  });

  describe("ReviewBulkIdsBodySchema", () => {
    it("requires at least one id", () => {
      expect(ReviewBulkIdsBodySchema.safeParse({ ids: ["a"] }).success).toBe(true);
      expect(ReviewBulkIdsBodySchema.safeParse({ ids: [] }).success).toBe(false);
      expect(ReviewBulkIdsBodySchema.safeParse({}).success).toBe(false);
    });
  });

  describe("ReviewNoteBodySchema", () => {
    it("requires non-empty content", () => {
      expect(ReviewNoteBodySchema.safeParse({ content: "note" }).success).toBe(true);
      expect(ReviewNoteBodySchema.safeParse({ content: "" }).success).toBe(false);
    });
  });

  describe("ReviewObjectSchema round-trip", () => {
    const baseResponse = {
      object: "review",
      id: "gw_rev_abc123",
      project_id: "gw_proj_1",
      template_id: "gw_tpl_1",
      template_slug: "test-template",
      payload: { content: "hello" },
      suggested_value: { content: "hello" },
      approved_value: null,
      callback_url: "https://example.com/hook",
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      decision: null,
      edited_payload: null,
      feedback: null,
      decided_by: null,
      decided_at: null,
      current_version: 1,
      assignee: null,
      metadata: null,
      draft_payload: null,
      draft_by: null,
      draft_at: null,
      action_value: null,
      action_label: null,
      created_at: "2026-04-17T00:00:00.000Z",
      updated_at: "2026-04-17T00:00:00.000Z",
      template: null,
    };

    it("parses a realistic server response with template === null", () => {
      const r = ReviewObjectSchema.safeParse(baseResponse);
      expect(r.success).toBe(true);
    });

    it("accepts iteration_count=0 (first-attempt review, no retries)", () => {
      const r = ReviewObjectSchema.safeParse({ ...baseResponse, iteration_count: 0 });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.iteration_count).toBe(0);
    });

    it("accepts iteration_count=3 (review that went through 3 retries)", () => {
      const r = ReviewObjectSchema.safeParse({ ...baseResponse, current_version: 4, iteration_count: 3 });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.iteration_count).toBe(3);
    });

    it("accepts review without iteration_count (optional field)", () => {
      const r = ReviewObjectSchema.safeParse(baseResponse);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.iteration_count).toBeUndefined();
    });

    it("rejects negative iteration_count", () => {
      const r = ReviewObjectSchema.safeParse({ ...baseResponse, iteration_count: -1 });
      expect(r.success).toBe(false);
    });

    it("rejects a response missing the template key", () => {
      // Invariant-lock: every review response (list, detail, mutations) now carries `template`.
      const r = ReviewObjectSchema.safeParse({
        object: "review",
        id: "gw_rev_abc123",
        project_id: "gw_proj_1",
        template_id: "gw_tpl_1",
        template_slug: "t",
        payload: {},
        priority: "normal",
        status: "pending",
        decision: null,
        edited_payload: null,
        feedback: null,
        decided_by: null,
        decided_at: null,
        current_version: 1,
        assignee: null,
        created_at: "2026-04-17T00:00:00.000Z",
        updated_at: "2026-04-17T00:00:00.000Z",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("ReviewListResponseSchema", () => {
    it("validates a list envelope", () => {
      const r = ReviewListResponseSchema.safeParse({
        object: "list",
        items: [],
        has_more: false,
        total: 0,
      });
      expect(r.success).toBe(true);
    });

    it("rejects wrong object discriminator", () => {
      const r = ReviewListResponseSchema.safeParse({
        object: "review",
        items: [],
        has_more: false,
      });
      expect(r.success).toBe(false);
    });
  });

  describe("template embed invariant (list and detail share shape)", () => {
    const baseItem = {
      object: "review",
      id: "gw_rev_abc123",
      project_id: "gw_proj_1",
      template_id: "gw_tpl_1",
      template_slug: "test-template",
      payload: { content: "hello" },
      suggested_value: { content: "hello" },
      approved_value: null,
      callback_url: null,
      priority: "normal",
      actions: ["approve", "reject"],
      status: "pending",
      decision: null,
      edited_payload: null,
      feedback: null,
      decided_by: null,
      decided_at: null,
      current_version: 1,
      assignee: null,
      metadata: null,
      draft_payload: null,
      draft_by: null,
      draft_at: null,
      action_value: null,
      action_label: null,
      created_at: "2026-04-17T00:00:00.000Z",
      updated_at: "2026-04-17T00:00:00.000Z",
    };

    const populatedTemplate = {
      id: "gw_tpl_1",
      slug: "test-template",
      name: "Test Template",
      fields: [
        { name: "content", label: "Content", type: "text", editable: true },
      ],
      actions: ["approve", "reject"],
      auto_approve: false,
      instructions: null,
    };

    it("accepts a review with a populated template embed", () => {
      const r = ReviewObjectSchema.safeParse({ ...baseItem, template: populatedTemplate });
      expect(r.success).toBe(true);
    });

    it("accepts a review with template === null (row has no template_id)", () => {
      const r = ReviewObjectSchema.safeParse({
        ...baseItem,
        template_id: null,
        template: null,
      });
      expect(r.success).toBe(true);
    });

    it("detail and list items share the same schema (invariant lock)", () => {
      // Both endpoints must now return the identical review object shape — enforced by
      // the tightened ReviewObjectSchema.template: embed.nullable() (required-nullable).
      const listItem = { ...baseItem, template: populatedTemplate };
      const detailItem = { ...baseItem, template: populatedTemplate };

      const listResponse = ReviewListResponseSchema.safeParse({
        object: "list",
        items: [listItem],
        has_more: false,
        total: 1,
      });
      const detailResponse = ReviewObjectSchema.safeParse(detailItem);

      expect(listResponse.success).toBe(true);
      expect(detailResponse.success).toBe(true);
      if (listResponse.success && detailResponse.success) {
        expect(listResponse.data.items[0]).toEqual(detailResponse.data);
      }
    });

    it("rejects a review missing the template key entirely", () => {
      // Every review response (list, detail, mutations) must carry template.
      const r = ReviewObjectSchema.safeParse(baseItem);
      expect(r.success).toBe(false);
    });

    it("rejects a template embed missing id or slug", () => {
      const missingId = ReviewObjectSchema.safeParse({
        ...baseItem,
        template: { slug: "test-template", name: "Test Template" },
      });
      expect(missingId.success).toBe(false);

      const missingSlug = ReviewObjectSchema.safeParse({
        ...baseItem,
        template: { id: "gw_tpl_1", name: "Test Template" },
      });
      expect(missingSlug.success).toBe(false);
    });
  });
});
