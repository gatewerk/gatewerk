import { describe, it, expect } from "vitest";
import {
  chainStepCount,
  countNamedFields,
  searchTemplates,
  sortTemplates,
  templateInTab,
  templateMetaParts,
  templateTabEmptyCopy,
  visibleTemplates,
  type TemplateListItem,
} from "./template-filters";

function tpl(over: Partial<TemplateListItem> = {}): TemplateListItem {
  return {
    id: "t1",
    slug: "vendor-payout",
    name: "Vendor payout",
    status: "active",
    default_priority: "normal",
    fields: [],
    draft_config: null,
    chain_config: null,
    ...over,
  };
}

describe("tab membership", () => {
  it("puts every template in All", () => {
    expect(templateInTab(tpl({ status: "draft" }), "all")).toBe(true);
    expect(templateInTab(tpl({ status: "inactive" }), "all")).toBe(true);
  });

  it("separates active from inactive", () => {
    expect(templateInTab(tpl({ status: "active" }), "active")).toBe(true);
    expect(templateInTab(tpl({ status: "inactive" }), "active")).toBe(false);
    expect(templateInTab(tpl({ status: "inactive" }), "inactive")).toBe(true);
  });

  it("counts a published template with unsaved edits as a draft", () => {
    // Deliberately not exclusive with Active: the tab answers "has unpublished
    // work", and a live template with a pending draft has exactly that.
    const pending = tpl({ status: "active", draft_config: { name: "new" } });
    expect(templateInTab(pending, "drafts")).toBe(true);
    expect(templateInTab(pending, "active")).toBe(true);
  });

  it("keeps a clean published template out of Drafts", () => {
    expect(templateInTab(tpl({ status: "active", draft_config: null }), "drafts")).toBe(false);
  });
});

describe("search", () => {
  const items = [tpl({ id: "a", name: "Vendor payout", slug: "vendor-payout" }), tpl({ id: "b", name: "Code deploy", slug: "code-deploy" })];

  it("matches on name and on slug", () => {
    expect(searchTemplates(items, "vendor").map((t) => t.id)).toEqual(["a"]);
    expect(searchTemplates(items, "code-dep").map((t) => t.id)).toEqual(["b"]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(searchTemplates(items, "  VENDOR ").map((t) => t.id)).toEqual(["a"]);
  });

  it("returns everything for a blank query", () => {
    expect(searchTemplates(items, "   ")).toHaveLength(2);
  });
});

describe("sort", () => {
  it("floats drafts above published, then orders by slug", () => {
    const items = [
      tpl({ id: "z", slug: "zebra", status: "active" }),
      tpl({ id: "d", slug: "yak", status: "draft" }),
      tpl({ id: "a", slug: "alpha", status: "active" }),
    ];
    expect(sortTemplates(items).map((t) => t.id)).toEqual(["d", "a", "z"]);
  });

  it("does not mutate its input", () => {
    const items = [tpl({ id: "z", slug: "zebra" }), tpl({ id: "a", slug: "alpha" })];
    sortTemplates(items);
    expect(items.map((t) => t.id)).toEqual(["z", "a"]);
  });
});

describe("field and chain counts", () => {
  it("ignores an unnamed field row, because the save drops it", () => {
    expect(countNamedFields([{ name: "amount" }, { name: "" }, {}])).toBe(1);
  });

  it("reads the step count off chain_config, and survives a malformed one", () => {
    expect(chainStepCount({ steps: [{}, {}, {}] })).toBe(3);
    expect(chainStepCount(null)).toBe(0);
    expect(chainStepCount({})).toBe(0);
    expect(chainStepCount({ steps: "three" as unknown })).toBe(0);
  });
});

describe("meta parts", () => {
  it("names a draft and its field count, all lowercase, no separators in the data", () => {
    const parts = templateMetaParts(tpl({ status: "draft", default_priority: "normal", fields: [{ name: "a" }, { name: "b" }] }));
    expect(parts).toEqual(["draft", "2 fields"]);
  });

  it("omits 'normal' priority entirely: the default carries no information", () => {
    const parts = templateMetaParts(tpl({ status: "active", default_priority: "normal", fields: [{ name: "a" }] }));
    expect(parts).toEqual(["1 field"]);
  });

  it("shows a non-default priority as a plain word: configuration, not an alarm", () => {
    expect(templateMetaParts(tpl({ status: "active", default_priority: "critical", fields: [{ name: "a" }] }))).toEqual([
      "critical",
      "1 field",
    ]);
    expect(templateMetaParts(tpl({ default_priority: "high", fields: [] }))[0]).toBe("high");
    expect(templateMetaParts(tpl({ default_priority: "low", fields: [] }))[0]).toBe("low");
  });

  it("marks unpublished changes on a live template", () => {
    const parts = templateMetaParts(tpl({ status: "active", draft_config: { name: "x" }, fields: [] }));
    expect(parts).toEqual(["unpublished changes", "0 fields"]);
  });

  it("names an inactive template, which the prototype left with no textual marker at all", () => {
    expect(templateMetaParts(tpl({ status: "inactive", fields: [] }))).toContain("inactive");
  });

  it("appends the chain only when there is one", () => {
    expect(templateMetaParts(tpl({ chain_config: { steps: [{}, {}, {}] }, fields: [] }))).toEqual([
      "0 fields",
      "chain 3",
    ]);
    expect(templateMetaParts(tpl({ chain_config: null, fields: [] }))).toEqual(["0 fields"]);
  });

  it("uses the singular for exactly one field", () => {
    expect(templateMetaParts(tpl({ fields: [{ name: "only" }] }))).toContain("1 field");
  });

  it("is lowercase throughout and carries no hyphen, em dash or middot", () => {
    const parts = templateMetaParts(
      tpl({ status: "active", draft_config: { a: 1 }, default_priority: "high", fields: [{ name: "x" }], chain_config: { steps: [{}] } }),
    );
    for (const p of parts) {
      expect(p).toBe(p.toLowerCase());
      expect(p).not.toMatch(/[-–—·]/);
    }
  });
});

describe("visibleTemplates", () => {
  it("filters by tab, then by query, then sorts", () => {
    const items = [
      tpl({ id: "1", slug: "zulu", name: "Zulu", status: "active" }),
      tpl({ id: "2", slug: "alpha", name: "Alpha", status: "active" }),
      tpl({ id: "3", slug: "bravo", name: "Bravo", status: "inactive" }),
      tpl({ id: "4", slug: "delta", name: "Delta", status: "draft" }),
    ];
    expect(visibleTemplates(items, "all", "").map((t) => t.id)).toEqual(["4", "2", "3", "1"]);
    expect(visibleTemplates(items, "active", "").map((t) => t.id)).toEqual(["2", "1"]);
    expect(visibleTemplates(items, "all", "a").map((t) => t.id)).toEqual(["4", "2", "3"]);
  });
});

describe("templateTabEmptyCopy", () => {
  // The regression this locks: the title used to be built by lowercasing the
  // tab LABEL, and "Drafts" lowercases to "drafts", so the drafts tab read
  // "No drafts templates". The board says "No drafts".
  it("titles the drafts tab without the trailing noun", () => {
    const items = [tpl({ id: "1", status: "active" }), tpl({ id: "2", status: "active" })];
    expect(templateTabEmptyCopy("drafts", items)).toEqual({
      title: "No drafts",
      hint: "All 2 templates are published.",
    });
  });

  it("counts what is NOT active for the active tab", () => {
    const items = [
      tpl({ id: "1", status: "inactive" }),
      tpl({ id: "2", status: "draft" }),
      tpl({ id: "3", status: "inactive" }),
    ];
    expect(templateTabEmptyCopy("active", items)).toEqual({
      title: "No active templates",
      hint: "3 are paused or drafts.",
    });
  });

  it("carries no hint on the inactive tab", () => {
    expect(templateTabEmptyCopy("inactive", [tpl()])).toEqual({ title: "No inactive templates" });
  });

  // A zero hint is worse than silence: "0 are paused or drafts" reads as a
  // fault report about a workspace that is simply small.
  it("omits a count hint rather than printing zero", () => {
    expect(templateTabEmptyCopy("active", []).hint).toBeUndefined();
    expect(templateTabEmptyCopy("drafts", []).hint).toBeUndefined();
  });

  it("holds every string to the no-dashes copy rule", () => {
    const items = [tpl({ status: "draft" })];
    for (const tab of ["active", "inactive", "drafts"] as const) {
      const copy = templateTabEmptyCopy(tab, items);
      expect(copy.title).not.toMatch(/[-–—]/);
      if (copy.hint) expect(copy.hint).not.toMatch(/[-–—]/);
    }
  });
});
