import { describe, expect, it } from "vitest";
import { STARTER_TEMPLATES, starterTemplateById } from "./starter-templates";
import { PRIORITIES, FIELD_TYPES } from "@gatewerk/shared";

// Server-side FieldNameSchema regex (packages/shared/src/api/schemas/templates.ts:61).
// Replicated locally so this test fails fast if a starter ships an invalid name —
// the equivalent failure on prod is a 400 on publish, well after the user has
// invested time editing the draft.
const FIELD_NAME_RE = /^[a-z0-9_]+$/;

describe("STARTER_TEMPLATES", () => {
  it("every field name passes the server FieldNameSchema regex", () => {
    for (const starter of STARTER_TEMPLATES) {
      for (const field of starter.draft.fields) {
        expect(field.name, `${starter.id} field ${field.name}`).toMatch(FIELD_NAME_RE);
      }
    }
  });

  it("every default_priority is a valid Priority", () => {
    for (const starter of STARTER_TEMPLATES) {
      expect(PRIORITIES).toContain(starter.draft.default_priority);
    }
  });

  it("every field type is a valid FieldType", () => {
    for (const starter of STARTER_TEMPLATES) {
      for (const field of starter.draft.fields) {
        expect(FIELD_TYPES).toContain(field.type);
      }
    }
  });

  it("starter ids are unique", () => {
    const ids = STARTER_TEMPLATES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every starter declares at least one field", () => {
    for (const starter of STARTER_TEMPLATES) {
      expect(starter.draft.fields.length).toBeGreaterThan(0);
    }
  });
});

describe("starterTemplateById", () => {
  it("returns the starter for every declared id", () => {
    for (const starter of STARTER_TEMPLATES) {
      expect(starterTemplateById(starter.id)).toBe(starter);
    }
  });
});
