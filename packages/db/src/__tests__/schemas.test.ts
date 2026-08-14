import { describe, it, expect } from "vitest";
import {
  insertReviewSchema,
  insertTemplateSchema,
} from "../schemas/index";

describe("insertReviewSchema field surface", () => {
  it("exposes exactly the expected caller-supplied fields", () => {
    expect(Object.keys(insertReviewSchema.shape).sort()).toEqual(
      [
        "actions",
        "assignee",
        "callback_url",
        "confidence",
        // migration 071: human soft-lock + snooze (caller-supplied on create/update)
        "held_at",
        "held_by",
        // migration 069: idempotency key (caller-supplied on create)
        "idempotency_key",
        "irreversibility",
        // migration 070: per-review iteration cap (caller-supplied)
        "max_iterations",
        "metadata",
        // migration 072: HOTL oversight mode (caller-supplied on create)
        "oversight",
        "payload",
        "priority",
        "project_id",
        // migration 071: snooze timer (caller-supplied)
        "snoozed_until",
        "template_id",
        "template_slug",
        "timeout_action",
        "timeout_seconds",
        // migration 070: agent trace deep-link (caller-supplied)
        "trace_url",
      ].sort(),
    );
  });

  it("strips server-controlled fields on parse (Zod default behavior)", () => {
    const parsed = insertReviewSchema.safeParse({
      project_id: "proj_x",
      template_slug: "t",
      payload: {},
      approved_value: "should-be-stripped",
      feedback: "should-be-stripped",
      expires_at: "2030-01-01T00:00:00Z",
    });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect("approved_value" in parsed.data).toBe(false);
    expect("feedback" in parsed.data).toBe(false);
    expect("expires_at" in parsed.data).toBe(false);
  });
});

describe("insertTemplateSchema field surface", () => {
  it("exposes exactly the expected caller-supplied fields", () => {
    expect(Object.keys(insertTemplateSchema.shape).sort()).toEqual(
      [
        "actions",
        // migration 072: HOTL monitoring opt-in (caller-supplied on create/update)
        "allow_monitoring",
        "allow_notes",
        "allow_request_changes",
        "auto_approve",
        "chain_config",
        "changes_timeout_hours",
        "default_auth_level",
        "default_expiry_seconds",
        "default_priority",
        "description",
        "enable_review_links",
        "fields",
        "instructions",
        // migration 070: template-level iteration cap default (caller-supplied)
        "max_iterations",
        "name",
        "project_id",
        "slug",
        "timeout_action",
        "timeout_seconds",
      ].sort(),
    );
  });
});
