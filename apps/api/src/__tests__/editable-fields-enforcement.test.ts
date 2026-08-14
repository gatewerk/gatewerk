// Server-side enforcement of `field.editable` (S1).
//
// Before this, `editable` was a client-side gate only. The server accepted any
// `edited_payload` and wrote it into `edited_payload` + `approved_value` —
// and `approved_value` is what the decision webhook hands the agent, and what
// a chain carries to its next step. So the template's declaration of what a
// reviewer may change was advisory.
//
// The actor that makes it matter is the external link recipient: a default
// `auth_level: 'public'` link needs no account, no cookie and no email. That
// path is covered here and in token-action-route.test.ts (T10).

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";
import {
  jsonValuesEqual,
  findNonEditableChanges,
  assertEditedPayloadAllowed,
} from "../services/reviews/editable-fields";

describe("findNonEditableChanges", () => {
  const fields = [
    { name: "note", editable: true },
    { name: "amount", editable: false },
    { name: "target" },
  ];

  it("allows a changed value on an editable field", () => {
    expect(findNonEditableChanges({ note: "new" }, { note: "old" }, fields)).toEqual([]);
  });

  it("flags a changed value on an explicitly non-editable field", () => {
    expect(findNonEditableChanges({ amount: 999 }, { amount: 100 }, fields)).toEqual(["amount"]);
  });

  it("treats a field with no editable flag as non-editable", () => {
    expect(findNonEditableChanges({ target: "prod" }, { target: "staging" }, fields)).toEqual([
      "target",
    ]);
  });

  it("allows an unchanged echo of a non-editable field", () => {
    // The shipping UIs submit {...payload, ...edits}, so echoes are the norm.
    expect(findNonEditableChanges({ amount: 100, target: "staging" }, { amount: 100, target: "staging" }, fields)).toEqual([]);
  });

  it("flags a key the template never declared", () => {
    expect(findNonEditableChanges({ injected: true }, {}, fields)).toEqual(["injected"]);
  });

  it("flags a forged media descriptor", () => {
    // crud.ts writes `_media_<field>` descriptors carrying stored_path; a
    // forged one would repoint a served object.
    const base = { _media_shot: { stored_path: "media/rev_1/shot.png" } };
    const forged = { _media_shot: { stored_path: "media/rev_other/shot.png" } };
    expect(findNonEditableChanges(forged, base, fields)).toEqual(["_media_shot"]);
  });

  it("reports every offender, sorted, not just the first", () => {
    const offenders = findNonEditableChanges(
      { amount: 1, target: "x", injected: 1, note: "fine" },
      { amount: 0, target: "y" },
      fields,
    );
    expect(offenders.sort()).toEqual(["amount", "injected", "target"]);
  });

  it("treats every key as non-editable when the field list is missing", () => {
    expect(findNonEditableChanges({ a: 1 }, { a: 0 }, null)).toEqual(["a"]);
    expect(findNonEditableChanges({ a: 1 }, { a: 0 }, [])).toEqual(["a"]);
  });

  it("is key-order insensitive for object values", () => {
    const base = { cfg: { a: 1, b: 2 } };
    const reserialized = { cfg: { b: 2, a: 1 } };
    expect(findNonEditableChanges(reserialized, base, fields)).toEqual([]);
  });
});

describe("jsonValuesEqual", () => {
  it("compares nested structures", () => {
    expect(jsonValuesEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonValuesEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it("does not treat a shorter array as equal to a longer one", () => {
    expect(jsonValuesEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("distinguishes null from absent and from falsy", () => {
    expect(jsonValuesEqual(null, undefined)).toBe(false);
    expect(jsonValuesEqual(null, 0)).toBe(false);
    expect(jsonValuesEqual(null, null)).toBe(true);
  });

  it("does not treat objects with the same key count but different keys as equal", () => {
    expect(jsonValuesEqual({ a: 1 }, { b: 1 })).toBe(false);
  });
});

describe("assertEditedPayloadAllowed", () => {
  it("is a no-op when no edited_payload was supplied", () => {
    expect(() => assertEditedPayloadAllowed(undefined, { a: 1 }, [])).not.toThrow();
    expect(() => assertEditedPayloadAllowed(null, { a: 1 }, [])).not.toThrow();
  });

  it("throws a field-level error naming every offender", () => {
    expect(() =>
      assertEditedPayloadAllowed({ amount: 1, target: "x" }, {}, [{ name: "note", editable: true }]),
    ).toThrow(/amount, target/);
  });
});

describe("field.editable enforcement over HTTP", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;

  const SLUG = "editable-gate";
  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;
    app = createApp({ db, eventBus: new EventBus() });

    await db.insert(templates).values({
      id: generateId("template"),
      slug: SLUG,
      project_id: projectId,
      name: "Editable gate",
      fields: [
        { name: "note", type: "text", label: "Note", editable: true },
        { name: "amount", type: "number", label: "Amount" },
      ],
      actions: [
        { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
        { id: "reject", label: "Reject", kind: "decision", decision_value: "rejected" },
        { id: "request_changes", label: "Request changes", kind: "iteration" },
      ],
    });
  });

  async function newReview() {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: SLUG, payload: { note: "original", amount: 100 } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function row(id: string) {
    const [r] = await db.select().from(reviewsTable).where(eq(reviewsTable.id, id));
    return r;
  }

  it("accepts an edit to an editable field and stores it as approved_value", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve", edited_payload: { note: "revised", amount: 100 } });

    expect(res.status).toBe(200);
    const r = await row(id);
    expect(r.approved_value).toEqual({ note: "revised", amount: 100 });
  });

  it("refuses an edit to a non-editable field and leaves the review untouched", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve", edited_payload: { note: "original", amount: 999999 } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");
    expect(res.body.error.param).toBe("edited_payload");

    const r = await row(id);
    expect(r.status).toBe("pending");
    expect(r.decision).toBeNull();
    expect(r.approved_value).toBeNull();
  });

  it("refuses a key the template never declared", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({
        action_id: "approve",
        edited_payload: { note: "original", amount: 100, admin_override: true },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");
    expect((await row(id)).status).toBe("pending");
  });

  it("gates the iteration branch too, not just decisions", async () => {
    // The iteration branch does not persist edited_payload but DOES echo it
    // into the audit row and the webhook, so an ungated iteration action
    // would let the ledger assert an edit the template forbids.
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({
        action_id: "request_changes",
        feedback: "please fix",
        edited_payload: { note: "original", amount: 42 },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");
    expect((await row(id)).status).toBe("pending");
  });

  it("still accepts a whole-payload echo with nothing changed", async () => {
    const id = await newReview();
    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve", edited_payload: { note: "original", amount: 100 } });

    expect(res.status).toBe(200);
    expect((await row(id)).approved_value).toEqual({ note: "original", amount: 100 });
  });

  it("uses the review's creation-time snapshot, so a later template edit cannot widen it", async () => {
    const id = await newReview();

    // Operator marks `amount` editable AFTER the review was created. The
    // in-flight review keeps the contract it was born with — the same P8
    // isolation reviews already get for rendering.
    await db
      .update(templates)
      .set({
        fields: [
          { name: "note", type: "text", label: "Note", editable: true },
          { name: "amount", type: "number", label: "Amount", editable: true },
        ],
      })
      .where(eq(templates.slug, SLUG));

    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve", edited_payload: { note: "original", amount: 555 } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");
  });

  it("falls back to the live template for a pre-snapshot review row", async () => {
    // Rows created before migration 073 have template_fields = NULL. They must
    // still be gated, from the live template row.
    //
    // The preceding test widens the live template, so restore it first — this
    // case reads the live row by definition and would otherwise assert against
    // the other test's mutation.
    await db
      .update(templates)
      .set({
        fields: [
          { name: "note", type: "text", label: "Note", editable: true },
          { name: "amount", type: "number", label: "Amount" },
        ],
      })
      .where(eq(templates.slug, SLUG));

    const id = generateId("review");
    await db.insert(reviewsTable).values({
      id,
      project_id: projectId,
      template_slug: SLUG,
      payload: { note: "original", amount: 100 },
      status: "pending",
      current_version: 1,
    });

    const res = await request(app)
      .post(`/api/v1/reviews/${id}/action`)
      .set(auth())
      .send({ action_id: "approve", edited_payload: { note: "original", amount: 7 } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("field_not_editable");
  });
});
