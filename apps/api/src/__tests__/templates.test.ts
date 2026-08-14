import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";

describe("Template CRUD", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("POST /api/v1/templates creates a template", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "email-review",
        name: "Email Review",
        description: "Review outbound emails",
        fields: [
          { name: "subject", type: "text", label: "Subject", readonly: true },
          { name: "body", type: "markdown", label: "Body", editable: true },
        ],
        actions: ["approve", "edit", "reject"],
      });
    expect(res.status).toBe(201);
    expect(res.body.object).toBe("template");
    expect(res.body.slug).toBe("email-review");
    expect(res.body.id).toBeDefined();
  });

  it("GET /api/v1/templates lists templates for the project", async () => {
    const res = await request(app).get("/api/v1/templates").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("GET /api/v1/templates/:id returns template details", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({ slug: "test-tpl", name: "Test", fields: [{ name: "content", type: "text", label: "Content" }], actions: ["approve", "reject"] });

    const res = await request(app)
      .get(`/api/v1/templates/${create.body.id}`)
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("template");
    expect(res.body.name).toBe("Test");
  });

  it("PUT /api/v1/templates/:id updates a template", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({ slug: "update-tpl", name: "Before", fields: [{ name: "content", type: "text", label: "Content" }], actions: ["approve", "reject"] });

    const res = await request(app)
      .put(`/api/v1/templates/${create.body.id}`)
      .set(auth())
      .send({ name: "After" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("After");
  });

  it("returns 422 with field details for missing required fields", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({ name: "No slug" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("validation_failed");
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.some((d: { path: string }) => d.path === "body.slug")).toBe(true);
  });

  it("DELETE /api/v1/templates/:id deletes a template", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({ slug: "delete-me", name: "Delete Me", fields: [{ name: "content", type: "text", label: "Content" }], actions: ["approve", "reject"] });
    expect(create.status).toBe(201);

    const del = await request(app)
      .delete(`/api/v1/templates/${create.body.id}`)
      .set(auth());
    expect(del.status).toBe(200);
    expect(del.body.object).toBe("template");
    expect(del.body.deleted).toBe(true);

    const get = await request(app)
      .get(`/api/v1/templates/${create.body.id}`)
      .set(auth());
    expect(get.status).toBe(404);
  });

  it("DELETE /api/v1/templates/:id returns 404 for unknown template", async () => {
    const res = await request(app)
      .delete("/api/v1/templates/gw_tpl_nonexistent")
      .set(auth());
    expect(res.status).toBe(404);
  });
});

// Spec §7.1 + §11.2 — route-level enforcement of action validation rules
// and canonical wire format.
describe("Template actions — §7.1 validation + §11.2 canonical wire", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("POST with bare-string actions stores+returns canonical (lazy write-back §11.2)", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "legacy-bare",
        name: "Legacy bare",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    expect(create.status).toBe(201);
    expect(Array.isArray(create.body.actions)).toBe(true);
    expect(create.body.actions[0]).toMatchObject({ id: "approve", kind: "decision", decision_value: "approved" });
    expect(create.body.actions[1]).toMatchObject({ id: "reject", kind: "decision", decision_value: "rejected" });

    // Round-trip via GET to verify the serializer normalizes consistently.
    const get = await request(app)
      .get(`/api/v1/templates/${create.body.id}`)
      .set(auth());
    expect(get.status).toBe(200);
    expect(get.body.actions[0]).toMatchObject({ id: "approve", kind: "decision" });
  });

  it("POST with canonical actions including a custom iteration succeeds", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "custom-action",
        name: "Custom",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
          { id: "reject", label: "Reject", kind: "decision", decision_value: "rejected" },
          { id: "escalate", label: "Escalate", kind: "iteration", webhook_event: "review.escalated", requires_feedback: true },
        ],
      });
    expect(create.status).toBe(201);
    expect(create.body.actions).toHaveLength(3);
    expect(create.body.actions[2]).toMatchObject({ id: "escalate", kind: "iteration", webhook_event: "review.escalated" });
  });

  it("POST with empty actions array → defaults to [approve, reject] presets (§3.3)", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "empty-actions",
        name: "Empty",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [],
      });
    expect(create.status).toBe(201);
    expect(create.body.actions).toHaveLength(2);
    expect(create.body.actions.map((a: { id: string }) => a.id)).toEqual(["approve", "reject"]);
  });

  it("POST with only-iteration actions → 400 template.no_terminal_action", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "iter-only",
        name: "Iter",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          { id: "request_changes", label: "Request Changes", kind: "iteration", webhook_event: "review.changes_requested" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template.no_terminal_action");
  });

  it("POST with duplicate action id → 400 template.duplicate_action_id", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "dup-id",
        name: "Dup id",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
          { id: "approve", label: "Approve again", kind: "decision", decision_value: "rejected" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template.duplicate_action_id");
  });

  it("POST with two decision_value='approved' → 400 template.duplicate_decision_value", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "dup-dv",
        name: "Dup dv",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          { id: "approve", label: "Approve", kind: "decision", decision_value: "approved" },
          { id: "ship_it", label: "Ship it", kind: "decision", decision_value: "approved" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template.duplicate_decision_value");
  });

  it("POST kind=decision missing decision_value → 400 template.missing_decision_value", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "missing-dv",
        name: "Missing dv",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: [
          { id: "approve", label: "Approve", kind: "decision" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("template.missing_decision_value");
  });

  it("PUT validates actions same as POST (§7.1 enforced on update)", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "put-validate",
        name: "Put validate",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    expect(create.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/templates/${create.body.id}`)
      .set(auth())
      .send({
        actions: [],
      });
    // Empty array on PUT defaults to presets (consistent with POST §3.3 default behavior).
    // To force a failure, send only iteration:
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(2);

    const reject = await request(app)
      .put(`/api/v1/templates/${create.body.id}`)
      .set(auth())
      .send({
        actions: [
          { id: "request_changes", label: "Request Changes", kind: "iteration", webhook_event: "review.changes_requested" },
        ],
      });
    expect(reject.status).toBe(400);
    expect(reject.body.error.code).toBe("template.no_terminal_action");
  });
});

// Spec §8.5 — template default_auth_level + default_expiry_seconds.
// Backing migration: 039-template-default-auth-and-expiry.sql.
// Consumed by ShareViaLinkDialog as pre-fill values at dialog open.
describe("Template defaults — §8.5 default_auth_level + default_expiry_seconds", () => {
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  // T1: create with all 3 link fields + echo back.
  it("POST creates template with all 3 link fields and echoes them back (T1)", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t1",
        name: "Defaults T1",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
        enable_review_links: true,
        default_auth_level: "email_otp",
        default_expiry_seconds: 604800,
      });
    expect(res.status).toBe(201);
    expect(res.body.enable_review_links).toBe(true);
    expect(res.body.default_auth_level).toBe("email_otp");
    expect(res.body.default_expiry_seconds).toBe(604800);
  });

  // T2: PATCH default_auth_level then GET round-trip.
  it("PUT updates default_auth_level and GET round-trips the persisted value (T2)", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t2",
        name: "Defaults T2",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    expect(create.status).toBe(201);

    const update = await request(app)
      .put(`/api/v1/templates/${create.body.id}`)
      .set(auth())
      .send({ default_auth_level: "account", default_expiry_seconds: 2592000 });
    expect(update.status).toBe(200);
    expect(update.body.default_auth_level).toBe("account");
    expect(update.body.default_expiry_seconds).toBe(2592000);

    const get = await request(app)
      .get(`/api/v1/templates/${create.body.id}`)
      .set(auth());
    expect(get.status).toBe(200);
    expect(get.body.default_auth_level).toBe("account");
    expect(get.body.default_expiry_seconds).toBe(2592000);
  });

  // T3: invalid default_auth_level rejected by Zod.
  it("rejects invalid default_auth_level with 422 Zod error (T3)", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t3",
        name: "Defaults T3",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
        default_auth_level: "public_link",
      });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("validation_failed");
    expect(
      res.body.error?.details?.some(
        (d: { path: string }) => d.path === "body.default_auth_level" || d.path === "default_auth_level",
      ),
    ).toBe(true);
  });

  // T4: out-of-range default_expiry_seconds rejected at both bounds.
  it("rejects default_expiry_seconds out of range with 422 (T4)", async () => {
    const zero = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t4-zero",
        name: "Defaults T4 zero",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
        default_expiry_seconds: 0,
      });
    expect(zero.status).toBe(422);
    expect(zero.body.error?.code).toBe("validation_failed");
    expect(
      zero.body.error?.details?.some(
        (d: { path: string }) => d.path === "body.default_expiry_seconds" || d.path === "default_expiry_seconds",
      ),
    ).toBe(true);

    const overcap = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t4-overcap",
        name: "Defaults T4 overcap",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
        default_expiry_seconds: 9999999,
      });
    expect(overcap.status).toBe(422);
    expect(overcap.body.error?.code).toBe("validation_failed");
  });

  // T-B1 (boundary): default_expiry_seconds = 2592001 (cap + 1) rejected.
  // Confirms the Zod range upper bound matches the migration 039 CHECK
  // constraint so a one-off-by-one slip would surface here as a test
  // failure instead of as a 500 from the DB CHECK.
  it("rejects default_expiry_seconds = 2592001 (cap + 1) with 422 (T-B1)", async () => {
    const res = await request(app).post("/api/v1/templates").set(auth()).send({
      slug: "tpl-defaults-b1",
      name: "Defaults B1",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      default_expiry_seconds: 2592001,
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("validation_failed");
  });

  // T5: bare create surfaces DB defaults (public + 86400s).
  it("bare create defaults to default_auth_level=public + default_expiry_seconds=86400 (T5)", async () => {
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-t5",
        name: "Defaults T5",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    expect(res.status).toBe(201);
    expect(res.body.default_auth_level).toBe("public");
    expect(res.body.default_expiry_seconds).toBe(86400);
  });

  // T-DP1: publish path defense-in-depth. PATCH /:id/draft accepts any
  // jsonb (TemplateDraftUpdateBodySchema = record<string,unknown>), so a
  // draft can carry a value that violates the published Zod range. Without
  // the publish-time Zod re-validation this would hit the storage CHECK
  // constraint as a 500. With the gate in place it surfaces as 422 with
  // field-level details that match the validate.ts middleware shape.
  it("rejects publish when draft contains invalid default_auth_level with 422 (T-DP1)", async () => {
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "tpl-defaults-dp1",
        name: "Defaults DP1",
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    expect(create.status).toBe(201);

    const patch = await request(app)
      .patch(`/api/v1/templates/${create.body.id}/draft`)
      .set(auth())
      .send({ default_auth_level: "future_tier" });
    expect(patch.status).toBe(200);

    const publish = await request(app)
      .post(`/api/v1/templates/${create.body.id}/publish`)
      .set(auth());
    expect(publish.status).toBe(422);
    expect(publish.body.error?.code).toBe("validation_failed");
    expect(
      publish.body.error?.details?.some(
        (d: { path: string }) =>
          d.path === "body.default_auth_level" || d.path === "default_auth_level",
      ),
    ).toBe(true);
  });

  it("allow_monitoring persists on create and update", async () => {
    // Create with allow_monitoring: true
    const create = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send({
        slug: "mon-toggle-tpl",
        name: "Monitoring Toggle",
        fields: [{ name: "action", type: "text", label: "Action" }],
        actions: ["approve", "reject"],
        allow_monitoring: true,
      });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const getAfterCreate = await request(app)
      .get(`/api/v1/templates/${id}`)
      .set(auth());
    expect(getAfterCreate.status).toBe(200);
    expect(getAfterCreate.body.allow_monitoring).toBe(true);

    // Update to false
    const update = await request(app)
      .put(`/api/v1/templates/${id}`)
      .set(auth())
      .send({ allow_monitoring: false });
    expect(update.status).toBe(200);

    const getAfterUpdate = await request(app)
      .get(`/api/v1/templates/${id}`)
      .set(auth());
    expect(getAfterUpdate.status).toBe(200);
    expect(getAfterUpdate.body.allow_monitoring).toBe(false);
  });
});
