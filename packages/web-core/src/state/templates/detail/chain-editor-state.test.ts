import { describe, it, expect } from "vitest";
import {
  blankStep,
  seedSteps,
  applyStepPatch,
  buildChainConfig,
  getEarlierSteps,
  mapServerErrors,
  moveStep,
  nameToId,
  MAX_STEPS,
} from "./chain-editor-state";
import type { ChainDefinition } from "@gatewerk/shared";

// Pure-logic coverage for the chain editor's working-state helpers. These
// helpers are the load-bearing seam between the React component and the wire
// shape — every behavior the spec listed (add step / submit payload / branch
// picker filter / clear-on-policy-switch / submit-as-null on empty / inline
// server-error mapping) reduces to a transformation tested here.
//
// Rendering is exercised end-to-end via Playwright (manual verification step
// per CLAUDE.md). The web app has no jsdom/RTL setup; adding it is a separable
// initiative.

function chainCfg(steps: ChainDefinition["steps"]): ChainDefinition {
  return {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    steps,
  };
}

describe("nameToId", () => {
  it("slugifies a human-readable name into a valid step id", () => {
    expect(nameToId("Team Lead Review")).toBe("team_lead_review");
    expect(nameToId("Finance")).toBe("finance");
    expect(nameToId("VP Sign-off")).toBe("vp_sign_off");
  });

  it("strips leading/trailing underscores from special chars at edges", () => {
    expect(nameToId(" --hello-- ")).toBe("hello");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(nameToId("   ")).toBe("");
  });
});

describe("seedSteps", () => {
  it("returns an empty array when chain_config is null/undefined", () => {
    expect(seedSteps(null)).toEqual([]);
    expect(seedSteps(undefined)).toEqual([]);
  });

  it("hydrates user-assignee step with email and reset role", () => {
    const cfg = chainCfg([
      {
        id: "draft",
        template: "draft-tpl",
        assignee: { kind: "user", email: "writer@example.com" },
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps).toHaveLength(1);
    expect(steps[0].stepId).toBe("draft");
    // C1: a step's template is not part of working state any more. The wire
    // value on a legacy config is simply not read.
    expect(steps[0]).not.toHaveProperty("template");
    expect(steps[0].assigneeMode).toBe("user");
    expect(steps[0].assigneeEmail).toBe("writer@example.com");
    expect(steps[0].assigneeRole).toBe("reviewer");
  });

  it("hydrates role-assignee step with role and empty email", () => {
    const cfg = chainCfg([
      {
        id: "approve",
        template: "approval",
        assignee: { kind: "role", role: "admin" },
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps[0].assigneeMode).toBe("role");
    expect(steps[0].assigneeRole).toBe("admin");
    expect(steps[0].assigneeEmail).toBe("");
  });

  it("leaves timeout_seconds in the raw stash rather than modelling it", () => {
    // Roadmap tier since S4: no control renders it, so working state does not
    // carry it and _stepRaw is what hands it back on save.
    const cfg = chainCfg([
      {
        id: "wait",
        template: "any",
        assignee: { kind: "user", email: "x@y.z" },
        timeout_seconds: 1800,
      },
    ]);
    expect(seedSteps(cfg)[0]._stepRaw!.timeout_seconds).toBe(1800);
  });

  it("hydrates stepName from the definition name field", () => {
    const cfg = chainCfg([
      {
        id: "team_lead",
        name: "Team Lead Review",
        template: "proposal-review",
        assignee: { kind: "role", role: "reviewer" },
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps[0].stepName).toBe("Team Lead Review");
    expect(steps[0].stepId).toBe("team_lead");
    expect(steps[0].idManuallyEdited).toBe(true);
  });

  it("defaults stepName to empty string when name is absent", () => {
    const cfg = chainCfg([
      { id: "s1", template: "t", assignee: { kind: "user", email: "a@b.c" } },
    ]);
    expect(seedSteps(cfg)[0].stepName).toBe("");
  });

  it("seeds rejection_policy + rejection_branch_to from definition", () => {
    const cfg = chainCfg([
      { id: "s1", template: "t", assignee: { kind: "user", email: "a@b.c" } },
      {
        id: "s2",
        template: "t",
        assignee: { kind: "user", email: "x@y.z" },
        rejection_policy: "branch",
        rejection_branch_to: 1,
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps[0].rejectionPolicy).toBe("abort");
    expect(steps[0].rejectionBranchTo).toBeNull();
    expect(steps[1].rejectionPolicy).toBe("branch");
    expect(steps[1].rejectionBranchTo).toBe(1);
  });
});

describe("getEarlierSteps", () => {
  it("returns empty for the first row (no earlier steps to branch back to)", () => {
    const steps = [blankStep(), blankStep(), blankStep()];
    expect(getEarlierSteps(steps, 0)).toEqual([]);
  });

  it("returns all steps strictly before the current row index, 1-based", () => {
    const steps = [blankStep(), blankStep(), blankStep()];
    steps[0].stepId = "alpha";
    steps[1].stepId = "beta";
    steps[2].stepId = "gamma";
    const out = getEarlierSteps(steps, 2);
    expect(out).toEqual([
      { stepNumber: 1, label: "alpha" },
      { stepNumber: 2, label: "beta" },
    ]);
  });

  it("falls back to 'Step N' label when stepId is blank", () => {
    const steps = [blankStep(), blankStep()];
    const out = getEarlierSteps(steps, 1);
    expect(out).toEqual([{ stepNumber: 1, label: "Step 1" }]);
  });
});

describe("applyStepPatch", () => {
  it("merges the patch into the targeted row only", () => {
    const steps = [blankStep(), blankStep()];
    const next = applyStepPatch(steps, 1, { assigneeEmail: "abc@example.com" });
    expect(next[0].assigneeEmail).toBe("");
    expect(next[1].assigneeEmail).toBe("abc@example.com");
  });

  it("clears rejectionBranchTo when policy switches away from 'branch'", () => {
    const steps = [blankStep(), blankStep()];
    steps[1].rejectionPolicy = "branch";
    steps[1].rejectionBranchTo = 1;
    const next = applyStepPatch(steps, 1, { rejectionPolicy: "abort" });
    expect(next[1].rejectionPolicy).toBe("abort");
    expect(next[1].rejectionBranchTo).toBeNull();
  });

  it("preserves rejectionBranchTo when policy stays 'branch' on patch", () => {
    const steps = [blankStep(), blankStep()];
    steps[1].rejectionPolicy = "branch";
    steps[1].rejectionBranchTo = 1;
    const next = applyStepPatch(steps, 1, { rejectionPolicy: "branch", stepName: "x" });
    expect(next[1].rejectionBranchTo).toBe(1);
  });
});

describe("buildChainConfig", () => {
  function user(email: string) {
    return { assigneeMode: "user" as const, assigneeEmail: email };
  }

  it("returns null config when there are no steps (caller submits chain_config: null)", () => {
    const res = buildChainConfig([]);
    expect(res.config).toBeNull();
    expect(res.errors).toEqual({});
  });

  it("collapses one valid user-assigned step into wire shape", () => {
    const step = blankStep();
    Object.assign(step, { stepId: "draft" }, user("writer@example.com"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    // C1: two things a step used to carry are gone. `template`, because the
    // route resolves one entry template for every step; and an explicit
    // default `rejection_policy`, because the editor renders no control for it
    // and NULL already means abort.
    expect(res.config).toEqual({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "draft",
          assignee: { kind: "user", email: "writer@example.com" },
        },
      ],
    });
  });

  it("auto-derives stepId from row index when blank", () => {
    const step = blankStep();
    Object.assign(step, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect(res.config!.steps[0].id).toBe("step_1");
  });

  it("no longer emits a missing-template error, because a step has no template", () => {
    // C1 retired the field. A step with a who is a complete step.
    const step = blankStep();
    Object.assign(step, { stepId: "draft" }, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
  });

  it("emits an error when user-assignee email is blank", () => {
    const step = blankStep();
    Object.assign(step, { stepId: "draft", assigneeMode: "user" });
    const res = buildChainConfig([step]);
    expect(res.errors["0.assigneeEmail"]).toBeTruthy();
  });

  it("emits a duplicate-id error when two steps share the same stepId", () => {
    const a = blankStep();
    const b = blankStep();
    Object.assign(a, { stepId: "draft" }, user("a@b.c"));
    Object.assign(b, { stepId: "draft" }, user("x@y.z"));
    const res = buildChainConfig([a, b]);
    expect(res.errors["1.stepId"]).toMatch(/already used/i);
  });

  it("emits name on the wire when stepName is set", () => {
    const step = blankStep();
    Object.assign(step, { stepName: "Team Lead Review", stepId: "team_lead" }, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect(res.config!.steps[0].name).toBe("Team Lead Review");
  });

  it("omits name from the wire when stepName is empty", () => {
    const step = blankStep();
    Object.assign(step, { stepId: "draft" }, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect(res.config!.steps[0].name).toBeUndefined();
  });

  it("emits no timeout_seconds for a step the editor created", () => {
    // A step added in the editor has no raw stash, and no control can set a
    // timeout, so the wire step must simply omit the key.
    const step = blankStep();
    Object.assign(step, { stepId: "wait" }, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect((res.config!.steps[0] as { timeout_seconds?: number }).timeout_seconds).toBeUndefined();
  });

  it("includes rejection_branch_to only when policy is 'branch'", () => {
    const step1 = blankStep();
    const step2 = blankStep();
    Object.assign(step1, { stepId: "s1" }, user("a@b.c"));
    Object.assign(step2, {
      stepId: "s2",
      template: "t",
      rejectionPolicy: "branch" as const,
      rejectionBranchTo: 1,
    }, user("x@y.z"));
    const res = buildChainConfig([step1, step2]);
    expect(res.errors).toEqual({});
    const wire2 = res.config!.steps[1] as { rejection_branch_to?: number };
    expect(wire2.rejection_branch_to).toBe(1);
  });

  it("DROPS rejection_branch_to when policy is not 'branch' (clear-on-switch invariant)", () => {
    // Even if the working state still carries a stale rejectionBranchTo (e.g.
    // because applyStepPatch wasn't called), the build must omit it. The wire
    // schema rejects rejection_branch_to when policy != branch.
    const step = blankStep();
    Object.assign(step, {
      stepId: "s1",
      template: "t",
      rejectionPolicy: "abort" as const,
      rejectionBranchTo: 1,
    }, user("a@b.c"));
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    const wire = res.config!.steps[0] as { rejection_branch_to?: number };
    expect(wire.rejection_branch_to).toBeUndefined();
  });

  it("flags missing rejection_branch_to when policy is 'branch'", () => {
    const a = blankStep();
    const b = blankStep();
    Object.assign(a, { stepId: "s1", template: "t" }, user("a@b.c"));
    Object.assign(b, {
      stepId: "s2",
      template: "t",
      rejectionPolicy: "branch" as const,
    }, user("x@y.z"));
    const res = buildChainConfig([a, b]);
    expect(res.errors["1.rejectionBranchTo"]).toBeTruthy();
  });
});

describe("mapServerErrors", () => {
  it("translates zod chain_config.steps[i].rejection_branch_to into a row.field key", () => {
    const errors = mapServerErrors([
      {
        path: ["body", "chain_config", "steps", 1, "rejection_branch_to"],
        message: "rejection_branch_to (2) must be less than the step's position (2) to avoid cycles",
      },
    ]);
    expect(errors).toEqual({
      "1.rejectionBranchTo": "rejection_branch_to (2) must be less than the step's position (2) to avoid cycles",
    });
  });

  it("falls back to '_row' key when the issue points at the step object itself (no field segment)", () => {
    const errors = mapServerErrors([
      { path: ["chain_config", "steps", 0], message: "Step is malformed" },
    ]);
    expect(errors["0._row"]).toBe("Step is malformed");
  });

  it("ignores issues that don't reference steps[]", () => {
    const errors = mapServerErrors([
      { path: ["body", "name"], message: "Name required" },
    ]);
    expect(errors).toEqual({});
  });

  it("accepts dotted string paths from validate middleware (numeric segments parse to numbers)", () => {
    const errors = mapServerErrors([
      {
        path: "body.chain_config.steps.1.rejection_branch_to",
        message: "must be less than the step's position",
      },
    ]);
    expect(errors["1.rejectionBranchTo"]).toBe("must be less than the step's position");
  });
});

// ─── external_token round-trip coverage ───────────────────────────────────────

describe("external_token round-trip (lossless)", () => {
  it("seeds assigneeMode='external_token' and populates sub-fields from the wire spec", () => {
    const cfg = chainCfg([
      {
        id: "ext",
        template: "review-tpl",
        assignee: {
          kind: "external_token",
          expires_in_seconds: 86400,
          grace_period_seconds: 3600,
          note: "Send to client",
        },
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps[0].assigneeMode).toBe("external_token");
    expect(steps[0].externalTokenExpiresInSeconds).toBe("86400");
    expect(steps[0].externalTokenGracePeriodSeconds).toBe("3600");
    expect(steps[0].externalTokenNote).toBe("Send to client");
  });

  it("stashes the full raw spec into _externalTokenRaw including fields the editor does not expose", () => {
    const cfg = chainCfg([
      {
        id: "ext",
        template: "t",
        assignee: {
          kind: "external_token",
          auth_level: "email_otp",
          auth_email: "client@acme.com",
          recipient_label: "Acme Inc",
          purpose: "Q2 budget approval",
          expires_in_seconds: 172800,
        },
      },
    ]);
    const steps = seedSteps(cfg);
    const raw = steps[0]._externalTokenRaw!;
    expect(raw.auth_level).toBe("email_otp");
    expect(raw.auth_email).toBe("client@acme.com");
    expect(raw.recipient_label).toBe("Acme Inc");
    expect(raw.purpose).toBe("Q2 budget approval");
  });

  it("UNKNOWN FIELD SURVIVES round-trip: load a spec with an extra field, save, the extra field is present on the wire", () => {
    // Simulate a future API field the editor doesn't know about.
    const cfg = chainCfg([
      {
        id: "ext",
        template: "t",
        assignee: {
          kind: "external_token",
          expires_in_seconds: 86400,
          // Cast to any so TS doesn't reject the unknown field in the test fixture.
          // The wire schema is expected to be forward-compatible.
          ...(({ future_field: "mystery_value" }) as Record<string, unknown>),
        } as ChainDefinition["steps"][number]["assignee"],
      },
    ]);
    const steps = seedSteps(cfg);
    // _externalTokenRaw must carry the unknown field.
    expect((steps[0]._externalTokenRaw as Record<string, unknown>)["future_field"]).toBe("mystery_value");

    // Now build and verify the unknown field survives in the wire output.
    const res = buildChainConfig(steps);
    // No validation error (external_token mode doesn't require email).
    expect(res.errors["0.assigneeEmail"]).toBeUndefined();
    const wireAssignee = res.config!.steps[0].assignee as Record<string, unknown>;
    expect(wireAssignee["future_field"]).toBe("mystery_value");
    expect(wireAssignee["kind"]).toBe("external_token");
    expect(wireAssignee["expires_in_seconds"]).toBe(86400);
  });

  it("editor-exposed fields overwrite the raw spec (not vice versa) on save", () => {
    // Raw spec has expires_in_seconds=86400; user edits it to 172800 in the UI.
    const cfg = chainCfg([
      {
        id: "ext",
        template: "t",
        assignee: { kind: "external_token", expires_in_seconds: 86400, note: "old note" },
      },
    ]);
    const steps = seedSteps(cfg);
    // Simulate user editing the expires and note fields.
    steps[0].externalTokenExpiresInSeconds = "172800";
    steps[0].externalTokenNote = "new note";

    const res = buildChainConfig(steps);
    const wireAssignee = res.config!.steps[0].assignee as Record<string, unknown>;
    expect(wireAssignee["expires_in_seconds"]).toBe(172800);
    expect(wireAssignee["note"]).toBe("new note");
  });

  it("clears expires_in_seconds from wire when the input is cleared by the user", () => {
    const cfg = chainCfg([
      {
        id: "ext",
        template: "t",
        assignee: { kind: "external_token", expires_in_seconds: 86400 },
      },
    ]);
    const steps = seedSteps(cfg);
    // User clears the field.
    steps[0].externalTokenExpiresInSeconds = "";

    const res = buildChainConfig(steps);
    const wireAssignee = res.config!.steps[0].assignee as Record<string, unknown>;
    expect(wireAssignee["expires_in_seconds"]).toBeUndefined();
  });
});

describe("moveStep", () => {
  it("returns the SAME reference on a no-op (from === to)", () => {
    const steps = [blankStep(), blankStep(), blankStep()];
    const result = moveStep(steps, 1, 1);
    expect(result).toBe(steps);
  });

  it("returns the SAME reference when from index is out of range", () => {
    const steps = [blankStep(), blankStep()];
    expect(moveStep(steps, -1, 0)).toBe(steps);
    expect(moveStep(steps, 5, 0)).toBe(steps);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 0, 5)).toBe(steps);
  });

  it("moves a step forward (from < to) and preserves all other steps in order", () => {
    const [a, b, c, d] = [blankStep(), blankStep(), blankStep(), blankStep()];
    a.stepId = "a"; b.stepId = "b"; c.stepId = "c"; d.stepId = "d";
    const result = moveStep([a, b, c, d], 0, 2);
    expect(result.map((s) => s.stepId)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a step backward (from > to) and preserves all other steps in order", () => {
    const [a, b, c, d] = [blankStep(), blankStep(), blankStep(), blankStep()];
    a.stepId = "a"; b.stepId = "b"; c.stepId = "c"; d.stepId = "d";
    const result = moveStep([a, b, c, d], 3, 1);
    expect(result.map((s) => s.stepId)).toEqual(["a", "d", "b", "c"]);
  });

  it("remaps 1-based rejection_branch_to when the referenced step moves", () => {
    // [A(1), B(2), C(3)] — C branches to B (position 2).
    // Move B (index 1) to the end (index 2): new order [A(1), C(2), B(3)].
    // C's branch_to must update from 2 → 3 (B is now at position 3).
    const [a, b, c] = [blankStep(), blankStep(), blankStep()];
    a.stepId = "a"; b.stepId = "b"; c.stepId = "c";
    c.rejectionPolicy = "branch";
    c.rejectionBranchTo = 2; // branches to B at position 2

    const result = moveStep([a, b, c], 1, 2); // move B to end
    expect(result.map((s) => s.stepId)).toEqual(["a", "c", "b"]);
    // C is now at index 1 (position 2); B is at index 2 (position 3).
    expect(result[1].rejectionBranchTo).toBe(3); // C now branches to B's new position
  });

  it("remaps branch_to for the moved step itself if it had a branch", () => {
    // [A(1), B(2), C(3)] — C branches to A (position 1).
    // Move C (index 2) to index 0: new order [C(1), A(2), B(3)].
    // C's branch_to pointed at A (old position 1 → new position 2).
    const [a, b, c] = [blankStep(), blankStep(), blankStep()];
    a.stepId = "a"; b.stepId = "b"; c.stepId = "c";
    c.rejectionPolicy = "branch";
    c.rejectionBranchTo = 1; // branches to A at position 1

    const result = moveStep([a, b, c], 2, 0);
    expect(result.map((s) => s.stepId)).toEqual(["c", "a", "b"]);
    // A moved from position 1 → position 2.
    expect(result[0].rejectionBranchTo).toBe(2);
  });

  it("leaves branch_to null on steps that had no branch", () => {
    const [a, b] = [blankStep(), blankStep()];
    a.stepId = "a"; b.stepId = "b";
    const result = moveStep([a, b], 0, 1);
    expect(result[0].rejectionBranchTo).toBeNull();
    expect(result[1].rejectionBranchTo).toBeNull();
  });
});

describe("20-step cap (MAX_STEPS)", () => {
  it("exports MAX_STEPS === 20 from the shared constant", () => {
    expect(MAX_STEPS).toBe(20);
  });

  it("buildChainConfig accepts exactly MAX_STEPS steps without a cap error", () => {
    const steps = Array.from({ length: MAX_STEPS }, (_, i) => {
      const s = blankStep();
      s.stepId = `step_${i + 1}`;
      s.assigneeMode = "user";
      s.assigneeEmail = `user${i}@example.com`;
      return s;
    });
    const res = buildChainConfig(steps);
    // Client-side build doesn't enforce the cap (that's server-side zod V16);
    // we just confirm it produces a valid config and no client errors.
    expect(res.config!.steps).toHaveLength(MAX_STEPS);
    expect(res.errors).toEqual({});
  });
});

describe("description + priority emission", () => {
  it("emits description on the wire when set on the working step", () => {
    const step = blankStep();
    Object.assign(step, {
      stepId: "s1",
      template: "t",
      assigneeMode: "user" as const,
      assigneeEmail: "a@b.c",
      description: "Requires finance sign-off",
    });
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect(res.config!.steps[0].description).toBe("Requires finance sign-off");
  });

  it("omits description from wire when empty", () => {
    const step = blankStep();
    Object.assign(step, { stepId: "s1", template: "t", assigneeMode: "user" as const, assigneeEmail: "a@b.c" });
    const res = buildChainConfig([step]);
    expect(res.config!.steps[0].description).toBeUndefined();
  });

  it("emits priority on the wire when set", () => {
    const step = blankStep();
    Object.assign(step, {
      stepId: "s1",
      template: "t",
      assigneeMode: "user" as const,
      assigneeEmail: "a@b.c",
      priority: "high" as const,
    });
    const res = buildChainConfig([step]);
    expect(res.errors).toEqual({});
    expect(res.config!.steps[0].priority).toBe("high");
  });

  it("omits priority from wire when blank", () => {
    const step = blankStep();
    Object.assign(step, { stepId: "s1", template: "t", assigneeMode: "user" as const, assigneeEmail: "a@b.c" });
    const res = buildChainConfig([step]);
    expect(res.config!.steps[0].priority).toBeUndefined();
  });

  it("seeds description and priority back from a persisted chain step", () => {
    const cfg = chainCfg([
      {
        id: "s1",
        template: "t",
        assignee: { kind: "user", email: "a@b.c" },
        description: "Finance approval required",
        priority: "critical",
      },
    ]);
    const steps = seedSteps(cfg);
    expect(steps[0].description).toBe("Finance approval required");
    expect(steps[0].priority).toBe("critical");
  });
});

// C1 (route model): a chain resolves ONE entry template and every step reviews
// the same request against it, so a step no longer names a template. The editor
// stops writing the field, including when re-saving a chain that was authored
// before the change.
describe("C1 — steps stop naming templates", () => {
  it("writes no template on a fresh step", () => {
    const step = { ...blankStep(), stepId: "s1", assigneeEmail: "alice@example.com" };
    const { config, errors } = buildChainConfig([step]);
    expect(errors).toEqual({});
    expect(config!.steps[0]).not.toHaveProperty("template");
  });

  it("drops a legacy step template when an existing chain is re-saved", () => {
    const seeded = seedSteps({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: "legacy_tpl", assignee: { kind: "user", email: "alice@example.com" } },
      ],
    } as any);
    const { config } = buildChainConfig(seeded);
    expect(config!.steps[0]).not.toHaveProperty("template");
  });

  it("no longer demands a template before it will save", () => {
    // The old editor refused to save a step with an empty template slug. There
    // is nothing to demand now.
    const { errors } = buildChainConfig([
      { ...blankStep(), stepId: "s1", assigneeEmail: "alice@example.com" },
    ]);
    expect(Object.keys(errors)).toEqual([]);
  });

  it("leaves rejection_policy unwritten when it is the default", () => {
    // The editor renders no control for it, and the tier registry records the
    // launch posture as "NULL means abort". Writing an explicit value from a
    // control that does not exist made an API-authored NULL come back set after
    // any dashboard save.
    const { config } = buildChainConfig([
      { ...blankStep(), stepId: "s1", assigneeEmail: "alice@example.com" },
    ]);
    expect(config!.steps[0]).not.toHaveProperty("rejection_policy");
  });

  it("still preserves an API-set rejection policy through an edit", () => {
    const seeded = seedSteps({
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "s1",
          template: "legacy_tpl",
          assignee: { kind: "user", email: "alice@example.com" },
          rejection_policy: "continue",
        },
      ],
    } as any);
    const { config } = buildChainConfig(seeded);
    expect((config!.steps[0] as any).rejection_policy).toBe("continue");
  });
});
