import { describe, it, expect } from "vitest";
import { ChainDefinitionSchema } from "@gatewerk/shared";

// ChainDefinitionSchema validation coverage (M10 Phase 1).
//
// The schema enforces V1-V16 from chain-definition-format §9. V17-V19 apply
// only to parallel_groups shapes which V13 rejects outright in OSS, so they
// aren't exercised here. V15 (cycle detection) is unreachable in sequential
// mode and is a no-op at this layer.

function minimalStep(overrides?: Partial<any>) {
  return {
    id: "step_1",
    template: "tpl",
    assignee: { kind: "user", email: "alice@example.com" },
    ...overrides,
  };
}

function validDefinition(overrides?: Partial<any>) {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps: [minimalStep()],
    ...overrides,
  };
}

function firstErrorCode(result: any): string | undefined {
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  return issue?.params?.code || issue?.code;
}

describe("ChainDefinitionSchema — happy paths", () => {
  it("accepts a minimal 1-step definition", () => {
    const result = ChainDefinitionSchema.safeParse(validDefinition());
    expect(result.success).toBe(true);
  });

  it("accepts a 3-step chain with mixed assignee kinds", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      steps: [
        { id: "s1", template: "t1", assignee: { kind: "user", email: "a@x.com" } },
        { id: "s2", template: "t2", assignee: { kind: "role", role: "admin" } },
        { id: "s3", template: "t3", assignee: { kind: "external_token" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("fills rejection_policy default to 'terminate'", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      steps: [minimalStep()],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rejection_policy).toBe("terminate");
  });
});

describe("ChainDefinitionSchema — V1 unsupported_version", () => {
  it("rejects version !== '1.0'", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      version: "2.0",
    });
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V2 mode_required / mode_not_supported (V13 in OSS)", () => {
  it("rejects missing mode", () => {
    const def: any = { ...validDefinition() };
    delete def.mode;
    const result = ChainDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });

  it("rejects mode='parallel' with feature_not_in_edition (V13)", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      mode: "parallel",
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });

  it("rejects mode='mixed' with feature_not_in_edition", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      mode: "mixed",
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });
});

describe("ChainDefinitionSchema — V3 steps_required", () => {
  it("rejects empty steps array", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing steps", () => {
    const def: any = { ...validDefinition() };
    delete def.steps;
    const result = ChainDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V4 invalid_rejection_policy", () => {
  it("rejects unknown rejection_policy value", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      rejection_policy: "ignore",
    });
    expect(result.success).toBe(false);
  });

  it("accepts back_one and restart at schema level (engine falls back to terminate)", () => {
    for (const policy of ["back_one", "restart"] as const) {
      const result = ChainDefinitionSchema.safeParse({
        ...validDefinition(),
        rejection_policy: policy,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("ChainDefinitionSchema — V5 step id rules", () => {
  it("rejects duplicate step ids with duplicate_step_id", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      steps: [minimalStep({ id: "same" }), minimalStep({ id: "same" })],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("duplicate_step_id");
  });

  it("rejects id with uppercase (regex)", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ id: "Step_1" })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects id with disallowed chars", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ id: "step@1" })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects id longer than 64 chars", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ id: "a".repeat(65) })],
    });
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V7 invalid_assignee_kind", () => {
  it("rejects unknown assignee kind", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "group" } })],
    });
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V8 user assignee requires ref", () => {
  it("rejects user assignee with neither email nor user_id", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "user" } })],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("assignee_user_missing_ref");
  });

  it("accepts user assignee with only user_id", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "user", user_id: "gw_usr_xyz" } })],
    });
    expect(result.success).toBe(true);
  });
});

describe("ChainDefinitionSchema — V9 invalid_role", () => {
  it("accepts role=admin and role=reviewer", () => {
    for (const role of ["admin", "reviewer"] as const) {
      const result = ChainDefinitionSchema.safeParse({
        ...validDefinition(),
        steps: [minimalStep({ assignee: { kind: "role", role } })],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects custom role names", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "role", role: "custom" } })],
    });
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V10 external_token bounds", () => {
  it("rejects expires_in_seconds < 3600", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "external_token", expires_in_seconds: 1800 } })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects expires_in_seconds > 2592000", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "external_token", expires_in_seconds: 3000000 } })],
    });
    expect(result.success).toBe(false);
  });

  it("rejects grace_period_seconds > 86400", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ assignee: { kind: "external_token", grace_period_seconds: 90000 } })],
    });
    expect(result.success).toBe(false);
  });
});

describe("ChainDefinitionSchema — V11 invalid_timeout", () => {
  it("rejects timeout_seconds < 60", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ timeout_seconds: 30 })],
    });
    expect(result.success).toBe(false);
  });

  it("accepts timeout_seconds = 60", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ timeout_seconds: 60 })],
    });
    expect(result.success).toBe(true);
  });
});

describe("ChainDefinitionSchema — V12 invalid_priority", () => {
  it("rejects unknown priority", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ priority: "urgent" })],
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid priorities", () => {
    for (const priority of ["low", "normal", "high", "critical"] as const) {
      const result = ChainDefinitionSchema.safeParse({
        ...validDefinition(),
        steps: [minimalStep({ priority })],
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("ChainDefinitionSchema — V13 feature_not_in_edition (Cloud gating)", () => {
  it("rejects top-level parallel_groups in OSS", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      parallel_groups: { phase1: { quorum_strategy: "all" } },
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });

  it("rejects step.parallel_group in OSS", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ parallel_group: "phase1" })],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });

  it("rejects step.condition in OSS", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [minimalStep({ condition: { payload_gt: { amount: 1000 } } })],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });
});

describe("ChainDefinitionSchema — V14 unknown_depends_on", () => {
  it("rejects depends_on referencing missing step id", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        minimalStep({ id: "s1" }),
        minimalStep({ id: "s2", depends_on: ["nonexistent"] }),
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("unknown_depends_on");
  });

  it("accepts depends_on referencing a sibling step", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        minimalStep({ id: "s1" }),
        minimalStep({ id: "s2", depends_on: ["s1"] }),
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("ChainDefinitionSchema — V16 too_many_steps", () => {
  it("accepts exactly 20 steps (the cap)", () => {
    const steps = Array.from({ length: 20 }, (_, i) => minimalStep({ id: `s${i}` }));
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps,
    });
    expect(result.success).toBe(true);
  });

  it("rejects 21 steps with too_many_steps", () => {
    const steps = Array.from({ length: 21 }, (_, i) => minimalStep({ id: `s${i}` }));
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps,
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("too_many_steps");
  });
});

// V13b — OSS edition gate: auth_level='account' is a Cloud-only feature.
// Mirrors the existing V13 parallel-mode OSS gate's edition-gating mechanism
// (unconditional in this OSS schema file; Cloud overrides in its own layer).
// Must fire BEFORE V20 so the edition error is unambiguous.
describe("ChainDefinitionSchema — V13b account auth_level is Cloud-only", () => {
  it("V13b-1 — rejects auth_level='account' on an external_token step in OSS", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "account",
            auth_user_id: "user_xyz",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });
});

// V13b coverage — additional cases
describe("ChainDefinitionSchema — V13b account auth_level (coverage)", () => {
  it("V13b-2 — auth_level='public' still PASSES (not blocked by V13b)", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token", auth_level: "public" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("V13b-3 — auth_level='email_otp' with auth_email PASSES (not blocked by V13b)", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token", auth_level: "email_otp", auth_email: "ok@example.com" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("V13b-4 — external_token with NO auth_level (back-compat) PASSES (V13b only checks explicit auth_level)", () => {
    // Back-compat case: a template with default_auth_level='account' and NO
    // explicit assignee auth_level does NOT trip V13b. The auth_level is
    // resolved at materialisation time from the template default — a Cloud
    // operator config concern outside this schema layer. V13b only fires when
    // auth_level is explicitly present on the step assignee itself.
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token" },
          // Intentionally NO auth_level — template default_auth_level='account'
          // would be resolved at materialisation, not here.
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("V13b-5 — account on step 2 of a 2-step chain also trips V13b", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "user", email: "alice@example.com" },
        },
        {
          id: "s2",
          template: "tpl",
          assignee: { kind: "external_token", auth_level: "account", auth_user_id: "user_xyz" },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
  });
});

// V20 — Cross-field auth-tier gate (§13) on
// external_token assignees. Mirrors the manual route gate in
// apps/api/src/routes/reviews/tokens.ts:24-83. Same five stable error
// codes so SDK callers branch on params.code uniformly across paths.
describe("ChainDefinitionSchema — V20 external_token auth-tier gate", () => {
  it("V20-1 — rejects email_otp without auth_email", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token", auth_level: "email_otp" },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("auth_level.email_required");
  });

  it("V20-2 — rejects public + auth_email", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "public",
            // RFC-compliant email so zod's email() base check passes and
            // execution reaches the cross-field superRefine.
            auth_email: "x@example.com",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("auth_level.contextual_fields_not_allowed_for_public");
  });

  it("V20-3 — rejects account without auth_user_id (feature_not_in_edition fires first in OSS)", () => {
    // V13b fires before V20 in OSS: auth_level='account' is Cloud-only, so
    // feature_not_in_edition is the first error code regardless of whether
    // auth_user_id is also missing. The V20 auth_level.user_id_required check
    // is still evaluated (superRefine collects all issues), but V13b wins the
    // firstErrorCode ordering.
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token", auth_level: "account" },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
    // V13b precedes V20 but does NOT subsume it — V20's account sub-rule
    // still fires (it is the sole account-tier guard in Cloud, where V13b is
    // absent). Assert the V20 code is present among all issues, not just first.
    if (!result.success) {
      const allCodes = result.error.issues.map((i: any) => i.params?.code ?? i.code);
      expect(allCodes).toContain("auth_level.user_id_required");
    }
  });

  it("V20-4 — accepts email_otp with auth_email", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "email_otp",
            auth_email: "ok@example.com",
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("V20-5 — accepts external_token with no auth_level (back-compat)", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: { kind: "external_token" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("V20-6 — rejects email_otp + auth_user_id", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "email_otp",
            auth_email: "ok@example.com",
            auth_user_id: "user_extra",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("auth_level.user_id_not_allowed_for_email_otp");
  });

  it("V20-7 — rejects account + auth_email (feature_not_in_edition fires first in OSS)", () => {
    // V13b fires before V20 in OSS: auth_level='account' is Cloud-only, so
    // feature_not_in_edition is the first error code. The V20
    // auth_level.email_not_allowed_for_account check is still evaluated but
    // V13b wins the firstErrorCode ordering.
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "account",
            auth_user_id: "user_xyz",
            auth_email: "extra@example.com",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("feature_not_in_edition");
    // V13b precedes V20 but does NOT subsume it — V20's account sub-rule
    // still fires (sole account-tier guard in Cloud, where V13b is absent).
    if (!result.success) {
      const allCodes = result.error.issues.map((i: any) => i.params?.code ?? i.code);
      expect(allCodes).toContain("auth_level.email_not_allowed_for_account");
    }
  });

  it("V20-8 — rejects public + auth_user_id", () => {
    const result = ChainDefinitionSchema.safeParse({
      ...validDefinition(),
      steps: [
        {
          id: "s1",
          template: "tpl",
          assignee: {
            kind: "external_token",
            auth_level: "public",
            auth_user_id: "user_123",
          },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(firstErrorCode(result)).toBe("auth_level.contextual_fields_not_allowed_for_public");
  });
});

// C1 (route model): a chain names ONE entry template on its envelope and the
// steps stop naming their own. `step.template` stays in the schema, optional
// and ignored by the engine, so an existing chain_config keeps validating.
describe("ChainDefinitionSchema — C1 entry template", () => {
  const routeStep = { id: "s1", assignee: { kind: "user", email: "alice@example.com" } };

  it("accepts an envelope template with no step templates", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      template: "expense-approval",
      steps: [routeStep],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.template).toBe("expense-approval");
  });

  it("still accepts a legacy definition whose steps name templates", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      steps: [{ ...routeStep, template: "legacy-tpl" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty envelope template rather than reading it as absent", () => {
    const result = ChainDefinitionSchema.safeParse({
      version: "1.0",
      mode: "sequential",
      template: "",
      steps: [routeStep],
    });
    expect(result.success).toBe(false);
  });
});
