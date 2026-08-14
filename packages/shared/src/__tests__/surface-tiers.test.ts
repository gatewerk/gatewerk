import { describe, it, expect } from "vitest";
import {
  SURFACE_TIER_TABLES,
  TEMPLATE_AXES,
  ACTION_AXES,
  TEMPLATE_EDITOR_GROUP_BUDGET,
  ACTION_FIELD_BUDGET,
  allDeclaredAxes,
  controlGroupsOn,
  publicRoadmap,
  type AxisDeclaration,
} from "../surface-tiers";

/**
 * The budgets.
 *
 * A number is arguable, which is the point. "Keep it lean" is a mood and it
 * erodes; "six" has to be argued up in a pull request.
 * These tests are the argument's venue.
 */
describe("surface budgets", () => {
  it("the template editor exposes exactly six control groups", () => {
    const groups = controlGroupsOn("template-editor");

    // Named, not just counted — a swap that keeps the count at six but replaces
    // `instructions` with something else is also a surface change.
    expect(groups).toEqual([
      "actions",
      "external-links",
      "fields",
      "identity",
      "instructions",
      "timeout",
    ]);
    expect(groups).toHaveLength(TEMPLATE_EDITOR_GROUP_BUDGET);
  });

  it("an action is exactly four fields", () => {
    const coreActionFields = Object.entries(ACTION_AXES)
      .filter(([, d]) => d.tier === "core")
      .map(([k]) => k)
      .sort();

    expect(coreActionFields).toEqual(["decision_value", "id", "kind", "label"]);
    expect(coreActionFields).toHaveLength(ACTION_FIELD_BUDGET);
  });

  it("action.style is one advanced bit on the editor, and does not join the four", () => {
    // Was "derived, never configured" until the loss was measured: every
    // reader honours style: "destructive", so a
    // destructive send-back was reachable over the API and unreachable in the
    // editor. It is a control now — but an advanced one, so the assertion
    // that matters is that the four core action fields did not become five.
    expect(ACTION_AXES.style.tier).toBe("advanced");
    expect("surface" in ACTION_AXES.style && ACTION_AXES.style.surface).toBe("template-editor");
    // The group already exists, so the editor's six groups stay six.
    expect("group" in ACTION_AXES.style && ACTION_AXES.style.group).toBe("actions");
  });

  it("chains are on their own screen, not inside the template editor's six", () => {
    // Routing stays in the engine, so chain_config is core — but it is a
    // separate surface. If it ever lands in the template editor the budget
    // above breaks, which is the intended alarm.
    const chainConfig = TEMPLATE_AXES.chain_config;
    expect(chainConfig.tier).toBe("core");
    expect("surface" in chainConfig && chainConfig.surface).toBe("chain-builder");
  });
});

/**
 * Structural invariants. Most are enforced by the type system already; these
 * catch the runtime shape, which is what the generators actually read.
 */
describe("declaration integrity", () => {
  const axes = allDeclaredAxes();

  it("declares axes across every registered subsystem", () => {
    expect(axes.length).toBeGreaterThan(0);
    for (const subsystem of Object.keys(SURFACE_TIER_TABLES)) {
      expect(
        axes.some((a) => a.subsystem === subsystem),
        `subsystem ${subsystem} has no axes`,
      ).toBe(true);
    }
  });

  it("axis ids are unique", () => {
    const ids = axes.map((a) => a.axisId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every held capability is named openly", () => {
    // Held features are named publicly. The type system
    // makes `roadmap.feature` required; this proves none of them is a blank or
    // a placeholder that would render as an empty roadmap line.
    for (const { axisId, declaration } of axes) {
      if (declaration.tier !== "roadmap") continue;
      expect(declaration.roadmap.feature.trim().length, `${axisId} has an empty roadmap feature`)
        .toBeGreaterThan(0);
      expect(typeof declaration.roadmap.built, `${axisId} must state built vs not-started`)
        .toBe("boolean");
    }
  });

  it("every inert axis carries its evidence", () => {
    // Calling something inert asserts it has no reader. That claim has to say why.
    for (const { axisId, declaration } of axes) {
      if (declaration.tier !== "inert") continue;
      expect(declaration.note.trim().length, `${axisId} is inert with no justification`)
        .toBeGreaterThan(0);
    }
  });

  it("only core and advanced axes claim a launch surface", () => {
    // A roadmap axis with a surface would be a contradiction: absent from the
    // UI, and also on a screen.
    for (const { axisId, declaration } of axes) {
      const surfaced = declaration.tier === "core" || declaration.tier === "advanced";
      expect("surface" in declaration, `${axisId} surface/tier mismatch`).toBe(surfaced);
    }
  });
});

describe("public roadmap generation", () => {
  const roadmap = publicRoadmap();

  it("groups axes into feature lines rather than leaking schema keys", () => {
    expect(roadmap.length).toBeGreaterThan(0);
    // Fewer lines than axes: the point of grouping is that nine action knobs
    // become a handful of readable promises.
    const roadmapAxisCount = allDeclaredAxes().filter((a) => a.declaration.tier === "roadmap").length;
    expect(roadmap.length).toBeLessThan(roadmapAxisCount);
  });

  it("keeps built-and-held separate from not-started", () => {
    // Two different promises. Everything built sorts first.
    const builtFlags = roadmap.map((r) => r.built);
    const firstNotStarted = builtFlags.indexOf(false);
    if (firstNotStarted !== -1) {
      expect(builtFlags.slice(firstNotStarted).every((b) => b === false)).toBe(true);
    }
  });

  it("marks a feature not-started unless every axis behind it is built", () => {
    // Parallel chains have schema surface but no implementation, so the line
    // must not read as shipped-and-hidden.
    const parallel = roadmap.find((r) => r.feature === "Parallel and conditional chains");
    expect(parallel).toBeDefined();
    expect(parallel!.built).toBe(false);
  });

  it("does not promise anything that is inert", () => {
    // The failure this prevents: putting `field.readonly` or `digest.at` on a
    // public roadmap, which would promise a capability that does nothing.
    const inertAxes = new Set(
      allDeclaredAxes()
        .filter((a) => a.declaration.tier === "inert")
        .map((a) => a.axisId),
    );
    for (const line of roadmap) {
      for (const axis of line.axes) {
        expect(inertAxes.has(axis), `${axis} is inert and must not appear on the roadmap`).toBe(false);
      }
    }
  });
});

describe("the rulings this file encodes", () => {
  it("holds monitoring gates back and names them", () => {
    const monitoring = publicRoadmap().find((r) => r.feature.startsWith("Monitoring gates"));
    expect(monitoring, "monitoring gates must appear on the public roadmap").toBeDefined();
    expect(monitoring!.built).toBe(true);
  });

  it("keeps the send-back loop in the launch core", () => {
    // "an agent asks · a human decides · the decision is recorded provably ·
    // the agent is told", plus send-back with feedback.
    const retry = allDeclaredAxes().find((a) => a.axisId === "review.retry.feedback");
    expect(retry?.declaration.tier).toBe("request");
  });

  it("does not hide a chain-step timeout that silently does nothing", () => {
    // No chain step can ever time out: materializeStep writes timeout_seconds
    // and never expires_at. Surfacing that knob would be the product lying.
    const stepTimeout = allDeclaredAxes().find((a) => a.axisId === "chain.step.timeout_seconds");
    expect(stepTimeout?.declaration.tier).toBe("roadmap");
    const decl = stepTimeout?.declaration as Extract<AxisDeclaration, { tier: "roadmap" }>;
    expect(decl.roadmap.built).toBe(false);
  });
});
