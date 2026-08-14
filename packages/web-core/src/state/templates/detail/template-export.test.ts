import { describe, it, expect } from "vitest";
import type { TemplateSchema, TemplateActionConfigCanonical } from "@gatewerk/shared";
import { buildTemplateExport } from "./template-export";

// S4 defect 3: the old read-only JSON view projected every field down to
// {name, type, label, editable-if-true}, silently dropping `options`. A
// select field's export was therefore invalid to paste back — the template
// requires options and the JSON never carried them. This test proves the
// round trip: build the export, serialize it exactly as DetailJsonTab does
// (JSON.stringify), parse it back, and assert the select field's options
// survived.

function selectTemplate(): TemplateSchema {
  return {
    id: "tpl_1",
    project_id: "prj_1",
    slug: "vendor-onboarding",
    name: "Vendor onboarding",
    description: "Multi step onboarding.",
    default_priority: "normal",
    fields: [
      { name: "vendor", type: "text", label: "Vendor" },
      {
        name: "liability_cap",
        type: "select",
        label: "Liability cap",
        options: ["low", "medium", "high"],
      },
    ],
    actions: [
      { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
    ],
  };
}

describe("buildTemplateExport", () => {
  it("round trips a select field's options through serialize/parse", () => {
    const exported = buildTemplateExport(selectTemplate());
    const roundTripped = JSON.parse(JSON.stringify(exported));

    const liabilityCap = roundTripped.fields.find((f: { name: string }) => f.name === "liability_cap");
    expect(liabilityCap.options).toEqual(["low", "medium", "high"]);
  });

  it("carries every field's options key through unmodified, not just select", () => {
    // Fidelity, not type based filtering: whatever the field actually has
    // survives. The text field here has no `options` at all, so it must not
    // gain one.
    const exported = buildTemplateExport(selectTemplate());
    const vendor = exported.fields as Array<Record<string, unknown>>;
    expect(vendor[0]).not.toHaveProperty("options");
    expect(vendor[1].options).toEqual(["low", "medium", "high"]);
  });

  it("emits editable unconditionally, not only when true", () => {
    const template = selectTemplate();
    template.fields[0].editable = true;
    const exported = buildTemplateExport(template);
    const fields = exported.fields as Array<Record<string, unknown>>;

    expect(fields[0].editable).toBe(true);
    expect(fields[1]).toHaveProperty("editable");
    expect(fields[1].editable).toBe(false);
  });

  it("includes the core axes the old view omitted entirely", () => {
    const template = selectTemplate();
    template.instructions = "Check the liability cap before approving.";
    template.timeout_seconds = 604800;
    template.timeout_action = "expire";
    (template as unknown as Record<string, unknown>).enable_review_links = true;
    template.chain_config = { version: "1.0", mode: "sequential", steps: [] };

    const exported = buildTemplateExport(template);

    expect(exported.instructions).toBe("Check the liability cap before approving.");
    expect(exported.timeout_seconds).toBe(604800);
    expect(exported.timeout_action).toBe("expire");
    expect(exported.enable_review_links).toBe(true);
    expect(exported.chain_config).toEqual({ version: "1.0", mode: "sequential", steps: [] });
  });

  it("projects actions to the four core axes, dropping roadmap-tier keys", () => {
    const template = selectTemplate();
    const actionsWithRoadmapKeys: TemplateActionConfigCanonical[] = [
      {
        id: "approve",
        label: "Approve",
        kind: "decision",
        decision_value: "approved",
        icon: "check",
        requires_feedback: true,
        webhook_event: "custom.event",
      },
    ];
    template.actions = actionsWithRoadmapKeys;

    const exported = buildTemplateExport(template);
    const actions = exported.actions as Array<Record<string, unknown>>;

    expect(actions[0]).toEqual({
      id: "approve",
      label: "Approve",
      kind: "decision",
      decision_value: "approved",
    });
  });
});
