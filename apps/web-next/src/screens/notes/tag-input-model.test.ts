import { describe, it, expect } from "vitest";
import {
  canAddTag,
  normaliseTag,
  suggestTags,
  tagDropdownVisible,
  tagFieldLayout,
  TAG_FIELD_HEIGHT,
  TAGS_MAX,
} from "./tag-input-model";

describe("normaliseTag", () => {
  it("lowercases and trims", () => {
    expect(normaliseTag("  Refunds ")).toBe("refunds");
  });
  it("leaves an invalid tag intact for the server to reject", () => {
    expect(normaliseTag("bad tag!")).toBe("bad tag!");
  });
});

describe("suggestTags", () => {
  it("offers matching tags that are not already selected", () => {
    expect(suggestTags(["policy", "postmortem", "refunds"], ["policy"], "po")).toEqual(["postmortem"]);
  });
  it("offers everything unselected for an empty input", () => {
    expect(suggestTags(["a", "b"], ["a"], "")).toEqual(["b"]);
  });
});

describe("canAddTag", () => {
  it("refuses a duplicate", () => {
    expect(canAddTag(["refunds"], "refunds")).toBe(false);
  });
  it("refuses an empty tag", () => {
    expect(canAddTag([], "")).toBe(false);
  });
  it("refuses beyond the cap", () => {
    const full = Array.from({ length: TAGS_MAX }, (_, i) => `t${i}`);
    expect(canAddTag(full, "one-more")).toBe(false);
  });
});

describe("tagDropdownVisible", () => {
  it("is false when not open, regardless of matches", () => {
    expect(tagDropdownVisible(["refunds"], [], "re", false)).toBe(false);
  });
  it("is false on a bare focus: open with nothing typed and no suggestions to offer", () => {
    // This is the exact state TagInput is in right after `onFocus` fires with
    // an empty field and no project tags yet. Escape must not be swallowed
    // here, because nothing is rendered for it to close.
    expect(tagDropdownVisible([], [], "", true)).toBe(false);
  });
  it("is true when open and a suggestion matches the typed text", () => {
    expect(tagDropdownVisible(["refunds", "policy"], [], "re", true)).toBe(true);
  });
  it("is true when open and nothing matches but the typed text could be created as a new tag", () => {
    expect(tagDropdownVisible(["refunds"], [], "newtag", true)).toBe(true);
  });
  it("is false when open and typed text exactly matches an already-selected tag (nothing to create, nothing to match)", () => {
    expect(tagDropdownVisible(["refunds"], ["refunds"], "refunds", true)).toBe(false);
  });
});

// Pins the actual invariant a screenshot can't — the field's height must be
// the exact same value at every tag count from 0 through the TAGS_MAX cap,
// not just "empty vs one tag", which is what let a second-row wrap
// regression through before.
describe("tagFieldLayout", () => {
  it("never wraps and is the same height at 0, 1, 5 and 10 tags", () => {
    const counts = [0, 1, 5, TAGS_MAX];
    const layouts = counts.map((n) => tagFieldLayout(n));
    for (const layout of layouts) {
      expect(layout.height).toBe(TAG_FIELD_HEIGHT);
      expect(layout.wrap).toBe("nowrap");
    }
    // Every count produces the literal same object shape, not just
    // coincidentally-equal fields.
    expect(new Set(layouts.map((l) => JSON.stringify(l))).size).toBe(1);
  });

  it("stays fixed even past the cap, so a caller never has to special-case an over-limit count", () => {
    expect(tagFieldLayout(TAGS_MAX + 5)).toEqual({ height: TAG_FIELD_HEIGHT, wrap: "nowrap" });
  });
});
