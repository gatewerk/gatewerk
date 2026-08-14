import { describe, it, expect } from "vitest";
import type { ChainDefinitionStep } from "@gatewerk/shared";
import type { templates } from "@gatewerk/db/src/schema/index";
import {
  resolveChainTokenInputs,
  scrubFutureStepAssigneeSpec,
} from "../services/chain-engine-token-resolution";

// Pure-logic coverage for resolveChainTokenInputs (§13) — exercises the
// assignee → template → fallback override chain across all branches
// without needing the DB harness.

type TemplateRow = typeof templates.$inferSelect;

function tpl(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    id: "gw_tpl_test",
    slug: "tpl",
    project_id: "gw_proj_test",
    name: "Test Template",
    description: null,
    fields: [],
    actions: ["approve", "reject"],
    default_priority: "normal",
    enable_review_links: true,
    auto_approve: false,
    timeout_seconds: null,
    timeout_action: null,
    changes_timeout_hours: null,
    instructions: null,
    allow_request_changes: true,
    allow_notes: true,
    default_auth_level: "public",
    default_expiry_seconds: 86400,
    status: "active",
    draft_config: null,
    draft_updated_at: null,
    chain_config: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as TemplateRow;
}

function step(overrides: Partial<ChainDefinitionStep> = {}): ChainDefinitionStep {
  return {
    id: "s1",
    template: "tpl",
    assignee: { kind: "external_token" },
    ...overrides,
  } as ChainDefinitionStep;
}

describe("resolveChainTokenInputs", () => {
  it("R1 — assignee with no overrides inherits template default_auth_level", () => {
    const out = resolveChainTokenInputs(step(), tpl({ default_auth_level: "email_otp" }));
    expect(out.auth_level).toBe("email_otp");
  });

  it("R2 — assignee.auth_level overrides template default", () => {
    const out = resolveChainTokenInputs(
      step({ assignee: { kind: "external_token", auth_level: "account", auth_user_id: "user_xyz" } }),
      tpl({ default_auth_level: "public" }),
    );
    expect(out.auth_level).toBe("account");
    expect(out.auth_user_id).toBe("user_xyz");
    expect(out.auth_email).toBeNull();
  });

  it("R3 — falls back to 'public' when template default is unknown", () => {
    const out = resolveChainTokenInputs(
      step(),
      tpl({ default_auth_level: "weird_legacy_value" as TemplateRow["default_auth_level"] }),
    );
    expect(out.auth_level).toBe("public");
  });

  it("R4 — recipient_label override chain (assignee → step.name → fallback)", () => {
    expect(
      resolveChainTokenInputs(
        step({ assignee: { kind: "external_token", recipient_label: "Alice's tier-2 review" } }),
        tpl(),
      ).recipient_label,
    ).toBe("Alice's tier-2 review");

    expect(
      resolveChainTokenInputs(step({ name: "Step name" }), tpl()).recipient_label,
    ).toBe("Step name");

    expect(resolveChainTokenInputs(step(), tpl()).recipient_label).toBe("(chain step)");
  });

  it("R5 — purpose override chain (assignee → step.name → fallback)", () => {
    expect(
      resolveChainTokenInputs(
        step({ assignee: { kind: "external_token", purpose: "QA gate" } }),
        tpl(),
      ).purpose,
    ).toBe("QA gate");

    expect(
      resolveChainTokenInputs(step({ name: "QA step" }), tpl()).purpose,
    ).toBe("QA step");

    expect(resolveChainTokenInputs(step(), tpl()).purpose).toBe("(chain-generated)");
  });

  it("R6 — expiryHours override chain (assignee seconds → template seconds → 7-day fallback)", () => {
    expect(
      resolveChainTokenInputs(
        step({ assignee: { kind: "external_token", expires_in_seconds: 3600 } }),
        tpl({ default_expiry_seconds: 7200 }),
      ).expiryHours,
    ).toBe(1);

    expect(
      resolveChainTokenInputs(step(), tpl({ default_expiry_seconds: 7200 })).expiryHours,
    ).toBe(2);

    // Floor at 1 hour even if both inputs are well below (would round to 0).
    expect(
      resolveChainTokenInputs(
        step({ assignee: { kind: "external_token", expires_in_seconds: 60 } }),
        tpl(),
      ).expiryHours,
    ).toBe(1);
  });

  it("R7 — public tier scrubs auth_email + auth_user_id even if assignee misroutes them", () => {
    // Wire schema would reject this upstream, but the resolver enforces
    // tier-only routing as defense-in-depth so the helper cannot leak
    // contextual fields to a public-tier token row.
    const a = {
      kind: "external_token" as const,
      auth_level: "public" as const,
      auth_email: "leak@example.com",
      auth_user_id: "leak_user_id",
    };
    const out = resolveChainTokenInputs(step({ assignee: a }), tpl());
    expect(out.auth_level).toBe("public");
    expect(out.auth_email).toBeNull();
    expect(out.auth_user_id).toBeNull();
  });

  it("R8 — account tier with no auth_user_id leaves auth_user_id null", () => {
    // Tier-only routing on account: when neither the assignee nor the
    // template default carries an auth_user_id, the resolver returns
    // null. Post-resolution invariant — tokenService.generate's helper
    // gate (assertAuthTierInvariant) rejects this downstream with
    // auth_level.user_id_required, but the resolver itself is pure
    // tier-routing logic and stays null-safe.
    const out = resolveChainTokenInputs(
      step({ assignee: { kind: "external_token", auth_level: "account" } }),
      tpl({ default_auth_level: "public" }),
    );
    expect(out.auth_level).toBe("account");
    expect(out.auth_user_id).toBeNull();
    expect(out.auth_email).toBeNull();
  });

  it("throws when called with a non-external_token assignee (defensive)", () => {
    expect(() =>
      resolveChainTokenInputs(
        step({ assignee: { kind: "user", email: "a@b.c" } }),
        tpl(),
      ),
    ).toThrow(/non-external_token/);
  });
});

// scrubFutureStepAssigneeSpec — future-step PII scrub (Task 4).
//
// The step projection shape has `assignee_spec` (the full ChainDefinitionStep
// stored as JSONB) rather than a bare `assignee` field. `assignee_spec.assignee`
// carries the assignee identity for future/pending steps that we must scrub
// for non-privileged callers.
describe("scrubFutureStepAssigneeSpec", () => {
  function makeStep(
    status: string,
    assigneeSpec: Record<string, unknown> = {
      id: "s1",
      template: "tpl",
      assignee: { kind: "user", email: "alice@example.com", user_id: "gw_usr_1" },
    },
  ) {
    return { id: "gw_cs_1", status, assignee_spec: assigneeSpec };
  }

  it("FS-1 — pending step: assignee_spec.assignee reduced to {kind} only for non-privileged", () => {
    const result = scrubFutureStepAssigneeSpec(makeStep("pending"), { isPrivileged: false });
    expect((result.assignee_spec as any).assignee).toEqual({ kind: "user" });
    expect((result.assignee_spec as any).assignee.email).toBeUndefined();
    expect((result.assignee_spec as any).assignee.user_id).toBeUndefined();
  });

  it("FS-2 — 'superseded' step: assignee_spec.assignee reduced to {kind} only (not yet reached)", () => {
    const result = scrubFutureStepAssigneeSpec(makeStep("superseded"), { isPrivileged: false });
    expect((result.assignee_spec as any).assignee).toEqual({ kind: "user" });
  });

  it("FS-3 — active step: full spec returned unchanged", () => {
    const result = scrubFutureStepAssigneeSpec(makeStep("active"), { isPrivileged: false });
    expect((result.assignee_spec as any).assignee.email).toBe("alice@example.com");
  });

  it("FS-4 — approved step: full spec returned unchanged", () => {
    const result = scrubFutureStepAssigneeSpec(makeStep("approved"), { isPrivileged: false });
    expect((result.assignee_spec as any).assignee.email).toBe("alice@example.com");
  });

  it("FS-5 — rejected step: full spec returned unchanged", () => {
    const result = scrubFutureStepAssigneeSpec(makeStep("rejected"), { isPrivileged: false });
    expect((result.assignee_spec as any).assignee.email).toBe("alice@example.com");
  });

  it("FS-6 — missing assignee_spec.assignee: step returned untouched", () => {
    const s = { id: "gw_cs_1", status: "pending", assignee_spec: { id: "s1" } };
    const result = scrubFutureStepAssigneeSpec(s, { isPrivileged: false });
    expect(result).toBe(s);
  });

  it("FS-7 — non-object assignee_spec: step returned untouched", () => {
    const s = { id: "gw_cs_1", status: "pending", assignee_spec: null as any };
    const result = scrubFutureStepAssigneeSpec(s, { isPrivileged: false });
    expect(result).toBe(s);
  });

  it("FS-8 — isPrivileged:true always returns full spec regardless of status", () => {
    const s = makeStep("pending");
    const result = scrubFutureStepAssigneeSpec(s, { isPrivileged: true });
    expect((result.assignee_spec as any).assignee.email).toBe("alice@example.com");
    expect(result).toBe(s);
  });
});
