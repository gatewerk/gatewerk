import { describe, it, expect } from "vitest";
import {
  availableTargets,
  kindLabel,
  pinDropdownVisible,
  pinKindLabel,
  targetsFromLists,
  type PinTarget,
} from "./pin-picker-model";

const target = (over: Partial<PinTarget>): PinTarget => ({
  kind: "template",
  id: "tpl_1",
  label: "Refund approval",
  ...over,
});

describe("targetsFromLists", () => {
  it("labels a template by its name", () => {
    const out = targetsFromLists([{ id: "tpl_1", name: "Refund approval" } as any]);
    expect(out).toEqual([{ kind: "template", id: "tpl_1", label: "Refund approval" }]);
  });

  it("returns nothing for an empty template list", () => {
    expect(targetsFromLists([])).toEqual([]);
  });
});

describe("availableTargets", () => {
  it("drops a target already present in pinned, by kind and id", () => {
    const targets = [target({}), target({ id: "tpl_2", label: "Pricing change" })];
    const pinned = [target({})];
    expect(availableTargets(targets, pinned)).toEqual([target({ id: "tpl_2", label: "Pricing change" })]);
  });

  it("keeps every target when nothing is pinned yet", () => {
    const targets = [target({}), target({ id: "tpl_2", label: "Pricing change" })];
    expect(availableTargets(targets, [])).toEqual(targets);
  });

  it("does not drop a target with the same id but a different kind", () => {
    // An existing note can carry a review pin whose id happens to collide
    // with a template id; that must never suppress the real template.
    const targets = [target({ id: "shared_id" })];
    const pinned = [{ kind: "review", id: "shared_id", label: "Some review" } as PinTarget];
    expect(availableTargets(targets, pinned)).toEqual(targets);
  });
});

describe("kindLabel", () => {
  it("names every kind", () => {
    expect(kindLabel("review")).toBe("REVIEW");
    expect(kindLabel("template")).toBe("TEMPLATE");
    expect(kindLabel("chain_run")).toBe("CHAIN RUN");
  });
});

describe("pinKindLabel", () => {
  it("names every kind as prose, with its article", () => {
    expect(pinKindLabel("review")).toBe("a review");
    expect(pinKindLabel("template")).toBe("a template");
    expect(pinKindLabel("chain_run")).toBe("a chain run");
  });

  it("is a different job from kindLabel, not a duplicate of it", () => {
    // fix round 2, Finding 6 collapsed two hand-maintained lowercase copies
    // (NoteRow and NoteComposer) into this one. The uppercase card eyebrow is
    // deliberately left separate. Both still name all three kinds, even
    // though the picker itself only ever produces "template" now — an
    // existing note can carry a "review" or "chain_run" pin from before the
    // template-only ruling (pin-picker-model.ts's file comment), and
    // NoteDetail/NoteRow must keep rendering those correctly.
    for (const kind of ["review", "template", "chain_run"] as const) {
      expect(pinKindLabel(kind)).not.toBe(kindLabel(kind));
      expect(pinKindLabel(kind)).toBe(pinKindLabel(kind).toLowerCase());
    }
  });
});

describe("pinDropdownVisible", () => {
  it("is false when not open", () => {
    expect(pinDropdownVisible(false, false)).toBe(false);
  });
  it("is false while the templates query is still loading, even if open", () => {
    expect(pinDropdownVisible(true, true)).toBe(false);
  });
  it("is true once open and loading has settled", () => {
    expect(pinDropdownVisible(true, false)).toBe(true);
  });
});
