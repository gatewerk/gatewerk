import { describe, it, expect } from "vitest";
import type { TemplateField, TemplateActionConfigCanonical } from "@gatewerk/shared";
import {
  addOption,
  changeFieldType,
  fieldNeedsOptions,
  fieldsForSave,
  removeOption,
  renameOption,
  typeCarriesOptions,
  usableOptions,
} from "./field-options-state";
import { canPublishTemplate } from "./publish-flow";

// S4 defect 1. The type dropdown offered `select`, no control anywhere could
// give the field its options, and the operator learned the rule as a 422.
//
// The two halves this file guards:
//   * the mutators the Configure panel drives (seed on type change, add,
//     rename, remove) — pure, so testable without a DOM;
//   * the array those mutators produce actually reaching the Publish gate. An
//     editable list has to insert an empty string before the operator can type
//     into it, and the shared publish rule counts array length, so a blank row
//     silently satisfied it.

function selectField(options?: string[]): TemplateField {
  return { name: "tier", type: "select", label: "Tier", ...(options ? { options } : {}) };
}

const validActions: TemplateActionConfigCanonical[] = [
  { id: "approve", label: "Approve", kind: "decision", decision_value: "approved", style: "primary" },
  { id: "reject", label: "Reject", kind: "decision", decision_value: "rejected", style: "primary" },
];

describe("typeCarriesOptions", () => {
  it("names select and nothing else", () => {
    expect(typeCarriesOptions("select")).toBe(true);
    expect(typeCarriesOptions("buttons")).toBe(false);
    expect(typeCarriesOptions("text")).toBe(false);
  });
});

describe("changeFieldType", () => {
  it("seeds an empty options array when the field becomes a select", () => {
    const field: TemplateField = { name: "tier", type: "text", label: "Tier" };
    expect(changeFieldType(field, "select")).toEqual({ type: "select", options: [] });
  });

  it("seeds empty rather than a blank placeholder row", () => {
    // A placeholder entry would make the field read as satisfied to the
    // length-only publish rule while holding nothing a reviewer could pick.
    const updates = changeFieldType({ name: "tier", type: "text", label: "Tier" }, "select");
    expect(updates.options).toEqual([]);
  });

  it("leaves an existing options array alone when re-picking select", () => {
    expect(changeFieldType(selectField(["gold", "silver"]), "select")).toEqual({ type: "select" });
  });

  it("does not touch options when the field moves away from select", () => {
    // Hide-never-delete at field level: a mis-click on the dropdown must not
    // destroy choices set over the API.
    expect(changeFieldType(selectField(["gold"]), "text")).toEqual({ type: "text" });
  });

  it("does not invent options for a type that never takes them", () => {
    const updates = changeFieldType({ name: "note", type: "text", label: "Note" }, "markdown");
    expect(updates).toEqual({ type: "markdown" });
    expect("options" in updates).toBe(false);
  });
});

describe("option mutators", () => {
  it("appends an empty row for the operator to type into", () => {
    expect(addOption(selectField([])).options).toEqual([""]);
    expect(addOption(selectField(["gold"])).options).toEqual(["gold", ""]);
  });

  it("appends onto an absent array without throwing", () => {
    expect(addOption(selectField()).options).toEqual([""]);
  });

  it("rewrites one entry and leaves the order untouched", () => {
    const field = selectField(["gold", "silver", "bronze"]);
    expect(renameOption(field, 1, "platinum").options).toEqual(["gold", "platinum", "bronze"]);
  });

  it("removes by index", () => {
    const field = selectField(["gold", "silver", "bronze"]);
    expect(removeOption(field, 0).options).toEqual(["silver", "bronze"]);
  });

  it("does not mutate the field it was handed", () => {
    const field = selectField(["gold"]);
    addOption(field);
    renameOption(field, 0, "silver");
    removeOption(field, 0);
    expect(field.options).toEqual(["gold"]);
  });
});

describe("usableOptions and the Needs options chip", () => {
  it("counts only entries with something in them", () => {
    expect(usableOptions(selectField(["gold", "", "  ", " silver "]))).toEqual(["gold", "silver"]);
  });

  it("flags a select field with no options", () => {
    expect(fieldNeedsOptions(selectField())).toBe(true);
    expect(fieldNeedsOptions(selectField([]))).toBe(true);
  });

  it("still flags a select field whose only row is blank", () => {
    expect(fieldNeedsOptions(selectField([""]))).toBe(true);
  });

  it("clears once a real option exists", () => {
    expect(fieldNeedsOptions(selectField(["gold"]))).toBe(false);
  });

  it("never flags a type that does not take options", () => {
    expect(fieldNeedsOptions({ name: "amount", type: "number", label: "Amount" })).toBe(false);
  });
});

describe("fieldsForSave", () => {
  it("drops unnamed rows", () => {
    const fields: TemplateField[] = [
      { name: "amount", type: "text", label: "Amount" },
      { name: "", type: "text", label: "" },
    ];
    expect(fieldsForSave(fields)).toHaveLength(1);
  });

  it("drops blank option rows the operator never typed into", () => {
    expect(fieldsForSave([selectField(["gold", ""])])[0].options).toEqual(["gold"]);
  });

  it("hands back the same field object when nothing needed cleaning", () => {
    const field = selectField(["gold", "silver"]);
    expect(fieldsForSave([field])[0]).toBe(field);
  });

  it("empties rather than deletes, so the shape survives", () => {
    const saved = fieldsForSave([selectField([""])])[0];
    expect(saved.options).toEqual([]);
    expect("options" in saved).toBe(true);
  });

  it("leaves an options array on a non-select field where the API put it", () => {
    const field: TemplateField = { name: "note", type: "text", label: "Note", options: ["a"] };
    expect(fieldsForSave([field])[0].options).toEqual(["a"]);
  });
});

describe("the Publish gate sees what the panel produced", () => {
  it("blocks a select field the operator has not configured", () => {
    expect(canPublishTemplate([selectField()], validActions)).toBe(false);
  });

  it("blocks a select field seeded by the type dropdown", () => {
    const field = { ...selectField(), ...changeFieldType(selectField(), "select") } as TemplateField;
    expect(canPublishTemplate([field], validActions)).toBe(false);
  });

  it("stays blocked while the only option row is still blank", () => {
    // The regression this file exists for. `addOption` has to insert an empty
    // string before the operator can type, and the shared rule counts length,
    // so an un-normalised gate turned Publish green on a select field holding
    // one unreadable choice. Proven to fail with `fieldsForSave` in
    // canPublishTemplate reduced to the old `fields.filter((f) => f.name)`.
    const field = { ...selectField(), ...addOption(selectField()) } as TemplateField;
    expect(field.options).toEqual([""]);
    expect(canPublishTemplate([field], validActions)).toBe(false);
  });

  it("stays blocked when every option is whitespace", () => {
    expect(canPublishTemplate([selectField(["   "])], validActions)).toBe(false);
  });

  it("opens once a real option is typed", () => {
    const blank = { ...selectField(), ...addOption(selectField()) } as TemplateField;
    const named = { ...blank, ...renameOption(blank, 0, "Up to 1x fees") } as TemplateField;
    expect(canPublishTemplate([named], validActions)).toBe(true);
  });

  it("blocks again when the last real option is removed", () => {
    const field = selectField(["gold"]);
    const emptied = { ...field, ...removeOption(field, 0) } as TemplateField;
    expect(canPublishTemplate([emptied], validActions)).toBe(false);
  });
});
