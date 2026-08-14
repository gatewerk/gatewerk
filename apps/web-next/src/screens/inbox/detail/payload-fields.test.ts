import { describe, it, expect } from "vitest";
import { resolveFields, inferType, toTitleCase } from "./payload-fields";

// ── inferType ──────────────────────────────────────────────────────────
describe("inferType", () => {
  it("boolean → boolean", () => expect(inferType(true)).toBe("boolean"));
  it("number → number", () => expect(inferType(42)).toBe("number"));
  it("url string → url", () => expect(inferType("https://example.com")).toBe("url"));
  it("plain string → text", () => expect(inferType("hello")).toBe("text"));
  it("array → json", () => expect(inferType(["a", "b"])).toBe("json"));
  it("object → json", () => expect(inferType({ x: 1 })).toBe("json"));
  it("null → text", () => expect(inferType(null)).toBe("text"));
  it("undefined → text", () => expect(inferType(undefined)).toBe("text"));
});

// ── toTitleCase ──────────────────────────────────────────────────────────
describe("toTitleCase", () => {
  it("snake_case", () => expect(toTitleCase("job_title")).toBe("Job Title"));
  it("camelCase", () => expect(toTitleCase("createdAt")).toBe("Created At"));
  it("single word", () => expect(toTitleCase("name")).toBe("Name"));
});

// ── resolveFields — payload-first, meta enrichment via template.fields ──
describe("resolveFields (payload-first, meta from template.fields)", () => {
  const review = {
    payload: {
      title: "Deploy v2",
      budget: 50000,
      summary: "Short summary",
      department: "Engineering",
    },
    template: {
      fields: [
        { name: "budget", label: "Budget (USD)", type: "number", editable: false },
        { name: "summary", label: "Summary", type: "markdown", editable: true },
        // "department" has no meta → fallback
      ],
    },
    template_fields: null,
  };

  it("order follows payload keys, not template order", () => {
    const fields = resolveFields(review);
    expect(fields.map((f) => f.name)).toEqual(["title", "budget", "summary", "department"]);
  });

  it("meta label used when available", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.budget.label).toBe("Budget (USD)");
    expect(byName.summary.label).toBe("Summary");
  });

  it("meta type used when valid FieldType", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.budget.type).toBe("number");
    expect(byName.summary.type).toBe("markdown");
  });

  it("infers type for keys with no meta", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title.type).toBe("text");
    expect(byName.department.type).toBe("text");
  });

  it("title-cases label when no meta", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title.label).toBe("Title");
    expect(byName.department.label).toBe("Department");
  });

  it("editable per meta (editable=false → false)", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.budget.editable).toBe(false);
    expect(byName.summary.editable).toBe(true);
    expect(byName.title.editable).toBe(false); // no meta → false
  });

  it("values come from payload", () => {
    const fields = resolveFields(review);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title.value).toBe("Deploy v2");
    expect(byName.budget.value).toBe(50000);
  });

  it("carries options when present in meta", () => {
    const r = {
      payload: { tone: "formal" },
      template: {
        fields: [{ name: "tone", label: "Tone", type: "select", editable: true, options: ["formal", "casual"] }],
      },
    };
    expect(resolveFields(r)[0].options).toEqual(["formal", "casual"]);
  });
});

// ── readonly flag handling ────────────────────────────────────────────────
describe("resolveFields (readonly handling)", () => {
  it("readonly:true overrides editable:true → not editable", () => {
    const r = {
      payload: { amount: 1000 },
      template: {
        fields: [{ name: "amount", label: "Amount", type: "number", editable: true, readonly: true }],
      },
    };
    expect(resolveFields(r)[0].editable).toBe(false);
  });

  it("editable:true + no readonly → editable", () => {
    const r = {
      payload: { note: "hi" },
      template: {
        fields: [{ name: "note", label: "Note", type: "text", editable: true }],
      },
    };
    expect(resolveFields(r)[0].editable).toBe(true);
  });

  it("editable absent → not editable", () => {
    const r = {
      payload: { x: "val" },
      template: { fields: [{ name: "x", label: "X", type: "text" }] },
    };
    expect(resolveFields(r)[0].editable).toBe(false);
  });
});

// ── template.fields preferred over template_fields snapshot ──────────────
describe("resolveFields (template.fields preferred over template_fields)", () => {
  it("uses template.fields when both present", () => {
    const r = {
      payload: { body: "hello" },
      template: {
        fields: [{ name: "body", label: "Live Label", type: "markdown", editable: true }],
      },
      template_fields: [
        { name: "body", label: "Snapshot Label", type: "text", editable: false },
      ],
    };
    const fields = resolveFields(r);
    expect(fields[0].label).toBe("Live Label");
    expect(fields[0].type).toBe("markdown");
    expect(fields[0].editable).toBe(true);
  });

  it("falls back to template_fields when template.fields absent", () => {
    const r = {
      payload: { subject: "hi" },
      template_fields: [
        { name: "subject", label: "Subject", type: "text", editable: true },
      ],
    };
    const fields = resolveFields(r);
    expect(fields[0].label).toBe("Subject");
    expect(fields[0].editable).toBe(true);
  });
});

// ── unknown/future type falls back to inferred ────────────────────────────
describe("resolveFields (unknown type falls back to inferType)", () => {
  it("unknown meta type → inferType from value", () => {
    const r = {
      payload: { x: 42 },
      template: { fields: [{ name: "x", label: "X", type: "future_type", editable: false }] },
    };
    expect(resolveFields(r)[0].type).toBe("number");
  });
});

// ── edge cases ────────────────────────────────────────────────────────────
describe("resolveFields (edge cases)", () => {
  it("null payload → empty array", () => {
    expect(resolveFields({ payload: null })).toEqual([]);
  });

  it("no template at all → all inferred, non-editable, title-cased", () => {
    const r = {
      payload: {
        job_title: "Engineer",
        salary: 120000,
        active: true,
        link: "https://example.com",
        meta: { x: 1 },
      },
    };
    const fields = resolveFields(r);
    expect(fields.map((f) => f.name)).toEqual(["job_title", "salary", "active", "link", "meta"]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.job_title.label).toBe("Job Title");
    expect(byName.salary.type).toBe("number");
    expect(byName.active.type).toBe("boolean");
    expect(byName.link.type).toBe("url");
    expect(byName.meta.type).toBe("json");
    expect(fields.every((f) => !f.editable)).toBe(true);
  });

  it("real-world mismatch: payload keys differ from template_fields names → all payload content renders", () => {
    // Bug regression: proposal review where template_fields names (job_title,
    // proposal, confidence) don't match payload keys (title, budget, summary...).
    // Payload-first ensures all content renders; no key returns null.
    const r = {
      payload: {
        title: "Senior Engineer",
        budget: 150000,
        summary: "Looking for a senior engineer",
        department: "Engineering",
        jd_outline: "Responsibilities: ...",
      },
      template_fields: [
        { name: "job_title", label: "Job Title", type: "text", editable: true },
        { name: "proposal", label: "Proposal", type: "markdown", editable: true },
        { name: "confidence", label: "Confidence", type: "number", editable: false },
      ],
    };
    const fields = resolveFields(r);
    // All 5 payload keys rendered (not 3 template_fields with value=null)
    expect(fields.map((f) => f.name)).toEqual(["title", "budget", "summary", "department", "jd_outline"]);
    // No meta match → all inferred
    expect(fields[0].type).toBe("text");
    expect(fields[1].type).toBe("number");
    // All non-editable (no matching meta for these payload keys)
    expect(fields.every((f) => !f.editable)).toBe(true);
  });
});
