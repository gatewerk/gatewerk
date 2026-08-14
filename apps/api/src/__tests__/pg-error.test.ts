// Guards the assumption that four separate constraint-collision handlers
// depend on (S1): that a Postgres error code survives drizzle's
// DrizzleQueryError wrapper.
//
// The synthetic cases below document the shape. The REAL value is the last
// test, which provokes an actual unique violation through drizzle and asserts
// the helper reads it — so a drizzle upgrade that changes the wrapping fails
// here, loudly, instead of silently reverting four handlers to 500s the way
// the 0.44 wrapping change already did once.

import { describe, it, expect } from "vitest";
import { pgErrorFields, isUniqueViolation } from "../lib/pg-error";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("pgErrorFields", () => {
  it("reads an unwrapped driver error", () => {
    expect(pgErrorFields({ code: "23505", constraint: "some_uniq" })).toEqual({
      code: "23505",
      constraint: "some_uniq",
    });
  });

  it("reads through one layer of wrapping", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: { code: "23505", constraint: "some_uniq" },
    });
    expect(pgErrorFields(wrapped)).toEqual({ code: "23505", constraint: "some_uniq" });
  });

  it("reads through several layers of wrapping", () => {
    const inner = { code: "23503", constraint: "fk_uniq" };
    const wrapped = { cause: { cause: { cause: inner } } };
    expect(pgErrorFields(wrapped)).toEqual({ code: "23503", constraint: "fk_uniq" });
  });

  it("returns nothing for a plain error", () => {
    expect(pgErrorFields(new Error("boom"))).toEqual({});
    expect(pgErrorFields(undefined)).toEqual({});
    expect(pgErrorFields(null)).toEqual({});
  });

  it("terminates on a self-referencing cause chain", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    expect(pgErrorFields(cyclic)).toEqual({});
  });

  it("matches a unique violation only on the named constraint", () => {
    const err = { cause: { code: "23505", constraint: "templates_project_id_slug_uniq" } };
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, "templates_project_id_slug_uniq")).toBe(true);
    // A guard written for one index must not swallow a collision on another.
    expect(isUniqueViolation(err, "reviews_project_id_idempotency_key_idx")).toBe(false);
  });

  it("does not treat a non-23505 code as a unique violation", () => {
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  it("CONTRACT: a real drizzle unique violation is still readable", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    const base = {
      project_id: seed.project.id,
      name: "N",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: [],
    };
    await db.insert(templates).values({ id: generateId("template"), slug: "collide", ...base });

    let thrown: unknown;
    try {
      await db.insert(templates).values({ id: generateId("template"), slug: "collide", ...base });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    // The shape this whole module exists for: drizzle's wrapper exposes
    // neither field directly.
    expect((thrown as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolation(thrown, "templates_project_id_slug_uniq")).toBe(true);
  });
});
