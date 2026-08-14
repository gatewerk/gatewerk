import { describe, it, expect } from "vitest";
import { seedEditorState, buildDraftConfig } from "./draft-config-state";
import { seedSteps, buildChainConfig, blankStep } from "./chain-editor-state";
import {
  applySubmittedAction,
  canonicalToFormState,
  extractPreserved,
  roleOf,
  validate,
} from "./action-editor-modal-state";
import type { ChainDefinition, TemplateActionConfigCanonical } from "@gatewerk/shared";

// The surface-tiering gate. The template editor renders six
// control groups; every other configuration axis stays reachable over the API
// and absent from the UI. The rule is HIDE, NEVER DELETE, which puts
// one obligation on the editor's save path:
//
//   An operator who opens a template and changes nothing but its name must not
//   lose a single value they set over the API.
//
// This file is that obligation as an executable gate. It runs the real seed →
// edit → save round trip over the two pure seams the editor saves through:
//
//   * `seedEditorState` / `buildDraftConfig` — the template body, PATCH /:id/draft
//   * `seedSteps` / `buildChainConfig`       — chain_config, PUT /templates/:id
//
// Rendering is not involved: both seams are pure, and the web app has no
// jsdom/RTL setup (see chain-editor-state.test.ts). Every removal in the S4
// plan lands behind this file passing.

// A template configured well past what the editor renders. Everything here
// except slug/name/description/fields/actions/default_priority/instructions/
// timeout_*/enable_review_links is roadmap tier: no control exists for it, so
// the save path is the only thing standing between it and deletion.
function roadmapTemplate(): Record<string, unknown> {
  return {
    id: "tpl_preserve",
    project_id: "prj_1",
    status: "active",
    slug: "vendor-payout",
    name: "Vendor payout",
    description: "Release a scheduled vendor payment",
    default_priority: "high",
    instructions: "Confirm the invoice number against the ledger.",
    fields: [
      { name: "amount", type: "text", label: "Amount" },
      {
        name: "tier",
        type: "select",
        label: "Tier",
        // Field-level roadmap tier.
        options: ["a", "b"],
        editable: true,
      },
    ],
    actions: [
      {
        id: "approve",
        label: "Approve",
        kind: "decision",
        decision_value: "approved",
        // Action-level roadmap tier — eight axes the four-control editor drops.
        requires_feedback: true,
        confirmation: true,
        icon: "check",
        order: 2,
        enabled_for_status: ["pending", "awaiting_external"],
        expose_to_recipient: false,
        description: "an agent-facing description",
      },
      {
        id: "escalate",
        label: "Escalate",
        kind: "side_effect",
        webhook_event: "custom.event",
      },
    ],
    // Template-level roadmap tier.
    auto_approve: true,
    allow_monitoring: true,
    allow_notes: false,
    allow_request_changes: false,
    max_iterations: 3,
    changes_timeout_hours: 12,
    default_auth_level: "email_otp",
    default_expiry_seconds: 3600,
    enable_review_links: true,
    timeout_seconds: 86400,
    timeout_action: "expire",
    draft_config: null,
  };
}

// Opens the editor on `template`, applies `edit` to the seeded state, saves.
function openEditAndSave(
  template: Record<string, unknown>,
  edit: (state: ReturnType<typeof seedEditorState>) => ReturnType<typeof seedEditorState>,
): Record<string, unknown> {
  return buildDraftConfig(edit(seedEditorState(template)), template);
}

describe("template editor save path preserves roadmap-tier values", () => {
  it("carries every template-level axis through a name-only edit", () => {
    const template = roadmapTemplate();
    const saved = openEditAndSave(template, (s) => ({ ...s, name: "Vendor payout v2" }));

    expect(saved.name).toBe("Vendor payout v2");

    expect(saved.auto_approve).toBe(true);
    expect(saved.allow_monitoring).toBe(true);
    expect(saved.allow_notes).toBe(false);
    expect(saved.allow_request_changes).toBe(false);
    expect(saved.max_iterations).toBe(3);
    expect(saved.changes_timeout_hours).toBe(12);
    expect(saved.default_auth_level).toBe("email_otp");
    expect(saved.default_expiry_seconds).toBe(3600);
  });

  it("does not null the timeout rows auto-approve has greyed out", () => {
    // A distinct mechanism from a dropped key: these two axes ARE modelled, but
    // auto-approve makes their controls unreachable, so a save wrote nulls over
    // values the operator had no way to see.
    const template = roadmapTemplate();
    const saved = openEditAndSave(template, (s) => ({ ...s, name: "Vendor payout v2" }));

    expect(saved.changes_timeout_hours).toBe(12);
    expect(saved.timeout_seconds).toBe(86400);
    expect(saved.timeout_action).toBe("expire");
  });

  it("carries every action-level axis through a name-only edit", () => {
    const template = roadmapTemplate();
    const saved = openEditAndSave(template, (s) => ({ ...s, name: "Vendor payout v2" }));

    const actions = saved.actions as Record<string, unknown>[];
    expect(actions).toHaveLength(2);

    expect(actions[0].requires_feedback).toBe(true);
    expect(actions[0].confirmation).toBe(true);
    expect(actions[0].icon).toBe("check");
    expect(actions[0].order).toBe(2);
    expect(actions[0].enabled_for_status).toEqual(["pending", "awaiting_external"]);
    expect(actions[0].expose_to_recipient).toBe(false);
    expect(actions[0].description).toBe("an agent-facing description");

    expect(actions[1].webhook_event).toBe("custom.event");
  });

  it("carries every field-level axis through a name-only edit", () => {
    const template = roadmapTemplate();
    const saved = openEditAndSave(template, (s) => ({ ...s, name: "Vendor payout v2" }));

    const fields = saved.fields as Record<string, unknown>[];
    expect(fields).toHaveLength(2);
    expect(fields[1].options).toEqual(["a", "b"]);
    expect(fields[1].editable).toBe(true);
  });

  it("preserves values already stashed in draft_config", () => {
    // The resumable-edit path: a previous save wrote the roadmap values into
    // draft_config, and the published columns have since diverged. The draft
    // is what the operator sees, so the draft is what must survive.
    const template = roadmapTemplate();
    template.max_iterations = 9;
    template.draft_config = { max_iterations: 3, allow_notes: false };

    const saved = openEditAndSave(template, (s) => ({ ...s, name: "Vendor payout v2" }));

    expect(saved.max_iterations).toBe(3);
    expect(saved.allow_notes).toBe(false);
  });

  it("still clears a timeout the operator actually switched off", () => {
    // Preservation must not calcify into "the editor can never null anything".
    // With auto-approve off the timeout rows are live controls, so emptying
    // them is a real instruction and has to reach the wire.
    const template = roadmapTemplate();
    template.auto_approve = false;

    const saved = openEditAndSave(template, (s) => ({
      ...s,
      timeoutSeconds: "",
      changesTimeoutHours: "",
    }));

    expect(saved.timeout_seconds).toBeNull();
    expect(saved.timeout_action).toBeNull();
    expect(saved.changes_timeout_hours).toBeNull();
  });
});

describe("chain editor save path preserves roadmap-tier step values", () => {
  // rejection_policy 'continue' and 'branch' are split across two steps on
  // purpose. The chain schema rejects rejection_branch_to on any step whose
  // policy is not 'branch' (packages/shared/src/api/schemas/chains.ts,
  // rejection_branch_to_misplaced), so a step carrying both 'continue' and a
  // branch target cannot exist on the wire and must not be asserted here.
  function roadmapChain(): ChainDefinition {
    return {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        {
          id: "step1",
          name: "Vendor confirms",
          template: "vendor-confirm",
          assignee: {
            kind: "external_token",
            grace_period_seconds: 3600,
            note: "Vendor has one hour after expiry",
          },
        },
        {
          id: "step2",
          name: "Finance",
          template: "finance-check",
          assignee: { kind: "role", role: "reviewer" },
          timeout_seconds: 600,
          rejection_policy: "continue",
          depends_on: ["step1"],
          metadata: { cost_centre: "ops" },
        },
        {
          id: "step3",
          name: "Director",
          template: "director-sign-off",
          assignee: { kind: "user", email: "director@example.com" },
          rejection_policy: "branch",
          rejection_branch_to: 1,
        },
      ],
    };
  }

  it("carries every step-level axis through a rename of step 2", () => {
    const steps = seedSteps(roadmapChain());
    steps[1] = { ...steps[1], stepName: "Finance review" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});

    const wire = config!.steps;
    expect(wire[1].name).toBe("Finance review");

    expect(wire[1].timeout_seconds).toBe(600);
    expect(wire[1].rejection_policy).toBe("continue");
    expect(wire[1].depends_on).toEqual(["step1"]);
    expect(wire[1].metadata).toEqual({ cost_centre: "ops" });

    expect(wire[2].rejection_policy).toBe("branch");
    expect(wire[2].rejection_branch_to).toBe(1);

    const assignee = wire[0].assignee as Record<string, unknown>;
    expect(assignee.kind).toBe("external_token");
    expect(assignee.grace_period_seconds).toBe(3600);
    expect(assignee.note).toBe("Vendor has one hour after expiry");
  });

  it("hands back the exact timeout_seconds the API set", () => {
    // step.timeout_seconds is roadmap tier and the step card no longer renders a
    // control for it, so a rename has to return the value untouched. It used to
    // travel through a minutes field: the schema allows any integer of 60 or
    // more (packages/shared/src/api/schemas/chains.ts), so 90 seconds seeded as
    // "2" minutes and saved back as 120. Nobody could see it happen, and nobody
    // could put it back.
    const chain = roadmapChain();
    chain.steps[0].timeout_seconds = 90;
    chain.steps[2].timeout_seconds = 3599;

    const steps = seedSteps(chain);
    steps[1] = { ...steps[1], stepName: "Finance review" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});
    expect(config!.steps[0].timeout_seconds).toBe(90);
    expect(config!.steps[2].timeout_seconds).toBe(3599);
  });

  it("still drops a step name the operator actually cleared", () => {
    const steps = seedSteps(roadmapChain());
    steps[1] = { ...steps[1], stepName: "" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});
    expect(config!.steps[1].name).toBeUndefined();
  });

  // The three cases below cover the CHAIN ENVELOPE rather than its steps.
  // buildChainConfig used to rebuild the envelope from a four-key literal, so
  // everything chain-level that the editor renders no control for was destroyed
  // on save. The fixture above could never catch it: its version / mode /
  // rejection_policy are exactly the three values the literal hardcoded, so the
  // round-trip looked lossless while silently overwriting them.
  it("keeps chain-level name, description, metadata and extensions across a save", () => {
    const chain = roadmapChain() as ChainDefinition & Record<string, unknown>;
    chain.name = "Vendor onboarding";
    chain.description = "Three-party sign-off for new suppliers";
    chain.metadata = { owner_team: "procurement", ticket: "OPS-4412" };
    chain.extensions = { experimental_sla_hours: 48 };

    const steps = seedSteps(chain);
    steps[1] = { ...steps[1], stepName: "Finance review" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});

    const saved = config as ChainDefinition & Record<string, unknown>;
    expect(saved.name).toBe("Vendor onboarding");
    expect(saved.description).toBe("Three-party sign-off for new suppliers");
    expect(saved.metadata).toEqual({ owner_team: "procurement", ticket: "OPS-4412" });
    expect(saved.extensions).toEqual({ experimental_sla_hours: 48 });
  });

  it("does not reset a non-default mode or rejection_policy the API set", () => {
    const chain = roadmapChain() as ChainDefinition & Record<string, unknown>;
    chain.mode = "parallel";
    // Chain-level policy is restart | terminate | back_one — "continue" is a
    // STEP-level policy and the two enums are not interchangeable.
    chain.rejection_policy = "back_one";

    const steps = seedSteps(chain);
    steps[0] = { ...steps[0], stepName: "Vendor confirms (renamed)" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});

    const saved = config as ChainDefinition & Record<string, unknown>;
    // A chain the API stored as parallel must not come back sequential just
    // because this editor renders no mode control.
    expect(saved.mode).toBe("parallel");
    expect(saved.rejection_policy).toBe("back_one");
    // The steps array is still rebuilt from working state.
    expect(saved.steps[0].name).toBe("Vendor confirms (renamed)");
  });

  it("keeps a user assignee's user_id, which no control exposes", () => {
    const chain = roadmapChain();
    // step3 is the kind:"user" assignee. user_id is the stable identifier;
    // email is only the current address.
    (chain.steps[2].assignee as Record<string, unknown>).user_id = "usr_7fd2c1";

    const steps = seedSteps(chain);
    steps[1] = { ...steps[1], stepName: "Finance review" };

    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});

    const assignee = config!.steps[2].assignee as Record<string, unknown>;
    expect(assignee.kind).toBe("user");
    expect(assignee.email).toBe("director@example.com");
    expect(assignee.user_id).toBe("usr_7fd2c1");
  });

  it("still applies envelope defaults for a chain built from scratch", () => {
    // Nothing was loaded, so there is no stash and the defaults must stand.
    const steps = [
      {
        ...blankStep(),
        stepName: "Only step",
        stepId: "only",
        template: "t",
        assigneeEmail: "someone@example.com",
      },
    ];
    const { config, errors } = buildChainConfig(steps);
    expect(errors).toEqual({});
    expect(config!.version).toBe("1.0");
    expect(config!.mode).toBe("sequential");
    expect(config!.rejection_policy).toBe("terminate");
  });
});

describe("action editor save path preserves roadmap-tier action values", () => {
  // The template-level round trip above never opens an action, so it cannot see
  // the modal's own seed → edit → save path. That path is where the S4 removal
  // bites hardest: the modal went from nine controls to two, and the seven
  // canonical keys it stopped rendering exist only in `preserved` now. Move one
  // of them back into FORM_OWNED_KEYS without a control to refill it and the
  // value is gone the first time an operator renames the button.

  function roadmapAction(): TemplateActionConfigCanonical {
    return {
      id: "approve",
      label: "Approve",
      kind: "decision",
      decision_value: "approved",
      // Every axis below is roadmap tier: reachable over the API, no control.
      style: "warning",
      requires_feedback: true,
      confirmation: true,
      expose_to_recipient: false,
      icon: "check",
      order: 2,
      enabled_for_status: ["pending", "awaiting_external"],
      description: "an agent-facing description",
    };
  }

  // Opens the modal on `action`, applies `edit` to the seeded form, saves.
  function openEditAndSave(
    action: TemplateActionConfigCanonical,
    edit: (f: ReturnType<typeof canonicalToFormState>) => ReturnType<typeof canonicalToFormState>,
  ): TemplateActionConfigCanonical {
    const result = validate(edit(canonicalToFormState(action)), extractPreserved(action), {
      isEdit: true,
      initialId: action.id,
      existingIds: [action.id],
      previousRole: roleOf(action),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("validate rejected the round trip");
    return result.value;
  }

  it("carries every unrendered action axis through a label-only edit", () => {
    const saved = openEditAndSave(roadmapAction(), (f) => ({ ...f, label: "Approve payout" }));

    expect(saved.label).toBe("Approve payout");
    expect(saved.kind).toBe("decision");
    expect(saved.decision_value).toBe("approved");

    expect(saved.requires_feedback).toBe(true);
    expect(saved.confirmation).toBe(true);
    expect(saved.expose_to_recipient).toBe(false);
    expect(saved.icon).toBe("check");
    expect(saved.order).toBe(2);
    expect(saved.enabled_for_status).toEqual(["pending", "awaiting_external"]);
    expect(saved.description).toBe("an agent-facing description");
    // Derived-from-role, but not at the cost of an API-set value the role would
    // never have produced.
    expect(saved.style).toBe("warning");
  });

  it("carries a custom webhook_event through a label-only edit of a side effect", () => {
    // webhook_event is only legal off kind=decision, so it needs its own action.
    const escalate: TemplateActionConfigCanonical = {
      id: "escalate",
      label: "Escalate",
      kind: "side_effect",
      webhook_event: "custom.event",
      requires_feedback: true,
    };
    const saved = openEditAndSave(escalate, (f) => ({ ...f, label: "Escalate to legal" }));

    expect(saved.label).toBe("Escalate to legal");
    expect(saved.webhook_event).toBe("custom.event");
    expect(saved.requires_feedback).toBe(true);
  });

  it("keeps the demoted action's unrendered axes when a role is taken from it", () => {
    // Demotion is a role change, not a delete. Only kind and decision_value move.
    const incumbent = roadmapAction();
    const challenger: TemplateActionConfigCanonical = {
      id: "sign_off",
      label: "Sign off",
      kind: "decision",
      decision_value: "approved",
    };

    const [demoted] = applySubmittedAction([incumbent], challenger, null);

    expect(demoted.kind).toBe("side_effect");
    expect(demoted.decision_value).toBeUndefined();

    expect(demoted.requires_feedback).toBe(true);
    expect(demoted.confirmation).toBe(true);
    expect(demoted.expose_to_recipient).toBe(false);
    expect(demoted.icon).toBe("check");
    expect(demoted.order).toBe(2);
    expect(demoted.enabled_for_status).toEqual(["pending", "awaiting_external"]);
    expect(demoted.description).toBe("an agent-facing description");
    expect(demoted.style).toBe("warning");
  });

  it("still applies the operator's actual role change", () => {
    // Preservation must not calcify into "the editor can never change anything".
    const saved = openEditAndSave(roadmapAction(), (f) => ({ ...f, role: "send_back" }));

    expect(saved.kind).toBe("iteration");
    expect(saved.decision_value).toBeUndefined();
  });
});
