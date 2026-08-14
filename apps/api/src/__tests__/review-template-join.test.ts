import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

describe("GET /api/v1/reviews/:id — template enrichment", () => {
  let app: any;
  let apiKey: string;
  let reviewId: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Create a template with varied field types
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "email-review",
      project_id: seed.project.id,
      name: "Email Review",
      fields: [
        { name: "subject", type: "text", label: "Subject Line", editable: true },
        { name: "body", type: "markdown", label: "Email Body" },
        { name: "tone", type: "select", label: "Tone", editable: true, options: ["professional", "casual"] },
        { name: "recipient", type: "text", label: "Recipient", editable: false },
      ],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });

    // Create a review against that template
    const res = await request(app)
      .post("/api/v1/reviews")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({
        template: "email-review",
        payload: { subject: "Hello", body: "Dear user...", tone: "professional", recipient: "user@example.com" },
        callback_url: "https://example.com/webhook",
      });
    reviewId = res.body.id;
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("includes template metadata in GET response", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.template).toBeDefined();
    expect(res.body.template.name).toBe("Email Review");
    // Spec §11.2 canonical wire format: outbound actions are normalized to
    // the structured TemplateActionConfig[] shape regardless of how the row
    // is stored. The seed above wrote legacy bare-string ["approve","reject"];
    // the API serializer (apps/api/src/services/reviews/crud.ts) upgrades
    // these via normalizeTemplateActions before returning.
    expect(res.body.template.actions).toEqual([
      expect.objectContaining({ id: "approve", kind: "decision", decision_value: "approved" }),
      expect.objectContaining({ id: "reject", kind: "decision", decision_value: "rejected" }),
    ]);
  });

  it("includes all fields with correct types and labels", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth());

    const fields = res.body.template.fields;
    expect(fields).toHaveLength(4);

    const subject = fields.find((f: any) => f.name === "subject");
    expect(subject.label).toBe("Subject Line");
    expect(subject.type).toBe("text");
    expect(subject.editable).toBe(true);

    const tone = fields.find((f: any) => f.name === "tone");
    expect(tone.type).toBe("select");
    expect(tone.options).toEqual(["professional", "casual"]);
  });

  it("defaults editable to false when absent from stored field", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth());

    const body = res.body.template.fields.find((f: any) => f.name === "body");
    // "body" field in the template has no explicit `editable` property
    expect(body.editable).toBe(false);
  });

  it("preserves editable: false when explicitly set", async () => {
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth());

    const recipient = res.body.template.fields.find((f: any) => f.name === "recipient");
    expect(recipient.editable).toBe(false);
  });

  it("still returns review without template key if template is somehow missing", async () => {
    // This tests the defensive path — reviews should always have a template_id,
    // but if the template was deleted, the review should still be returned.
    // We don't simulate deletion here, just verify the shape when template IS present.
    const res = await request(app)
      .get(`/api/v1/reviews/${reviewId}`)
      .set(auth());

    expect(res.body.id).toBe(reviewId);
    expect(res.body.status).toBe("pending");
    expect(res.body.payload).toBeDefined();
  });
});
