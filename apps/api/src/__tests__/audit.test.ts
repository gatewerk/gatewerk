import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";
import { createApp } from "../app";
import { createAuditService } from "../services/audit";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, auditLog } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { eq } from "drizzle-orm";
import { config } from "../config";

describe("Audit Trail", () => {
  let db: any;
  let app: any;
  let apiKey: string;
  let auditService: ReturnType<typeof createAuditService>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    // Create a template for review integration tests
    await db.insert(templates).values({
      id: generateId("template"),
      slug: "audit-test",
      project_id: seed.project.id,
      name: "Audit Test Template",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    auditService = createAuditService(db);
    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  it("AuditService.log creates an entry with HMAC signature", async () => {
    const entry = await auditService.log({
      action: "review.created",
      actor: "agent:gwk_test1",
      resource_type: "review",
      resource_id: "00000000-0000-0000-0000-000000000001",
      details: { template: "test-review" },
    });

    expect(entry.id).toBeDefined();
    expect(entry.action).toBe("review.created");
    expect(entry.actor).toBe("agent:gwk_test1");
    expect(entry.resource_type).toBe("review");
    expect(entry.signature).toBeDefined();
    expect(typeof entry.signature).toBe("string");
    expect(entry.signature!.length).toBe(64); // SHA-256 hex length
  });

  it("AuditService.log signature can be verified", async () => {
    // Details keys are deliberately NOT in alphabetical order and there are
    // several of them. The previous version of this test used a single-key
    // details object, which is why it never caught the v2 defect: one key has
    // no order to permute, so plain JSON.stringify round-tripped identically.
    const entry = await auditService.log({
      action: "review.decided",
      actor: "reviewer:test@example.com",
      resource_type: "review",
      resource_id: "00000000-0000-0000-0000-000000000002",
      details: { decision: "approved", actor_kind: "human", was_edited: false, iteration: 2 },
    });

    // New rows are written with signature_version=3 — v2 chain input plus a
    // canonical (key-sorted) serialisation of details, so the signature does
    // not depend on the key order Postgres happens to return from JSONB.
    expect(entry.signature_version).toBe(3);
    expect(entry.prev_signature).toBeDefined();

    const canonical = (v: unknown): string =>
      JSON.stringify(
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as any)[k]]))
          : v,
      );

    const v3Input = [
      "v3",
      entry.prev_signature!,
      entry.action,
      entry.actor,
      entry.resource_type,
      entry.resource_id || "",
      canonical(entry.details || {}),
      entry.created_at.toISOString(),
    ].join("|");

    const expected = createHmac("sha256", config.hmacSecret)
      .update(v3Input)
      .digest("hex");

    expect(entry.signature).toBe(expected);
  });

  // The regression net for the v2 defect: a row with multiple details keys
  // must verify. Before canonical signing this returned signature_mismatch
  // for every such row, which meant an auditor could not tell lawful activity
  // from tampering.
  it("verifies rows whose details have many keys in non-alphabetical order", async () => {
    const entry = await auditService.log({
      action: "review.decided",
      actor: "reviewer:multikey@example.com",
      resource_type: "review",
      resource_id: "00000000-0000-0000-0000-000000000042",
      details: { zebra: 1, apple: "two", nested: { delta: 4, bravo: 3 }, list: [3, 1, 2] },
    });

    const results = await auditService.verify(entry.project_id ?? null);
    const mine = results.find((r) => r.row_id === entry.id);
    expect(mine).toBeDefined();
    expect(mine!.reason).toBe("valid");
  });

  // The safety half of the fix. Canonical signing must make honest multi-key
  // rows verify WITHOUT making tampered ones verify too — otherwise it would
  // trade a false alarm for a blind spot, which is far worse. This is the
  // exact case that was previously indistinguishable: a multi-key row that
  // reported signature_mismatch whether or not anyone had touched it.
  it("still detects tampering with a value inside multi-key details", async () => {
    const entry = await auditService.log({
      action: "review.decided",
      actor: "reviewer:tamper@example.com",
      resource_type: "review",
      resource_id: "00000000-0000-0000-0000-000000000043",
      details: { decision: "rejected", reviewer_id: "r-1", was_edited: false },
    });

    const before = await auditService.verify(entry.project_id ?? null);
    expect(before.find((r) => r.row_id === entry.id)!.reason).toBe("valid");

    // Flip the decision — the single most consequential field in the row.
    await db
      .update(auditLog)
      .set({ details: { decision: "approved", reviewer_id: "r-1", was_edited: false } as any })
      .where(eq(auditLog.id, entry.id));

    const after = await auditService.verify(entry.project_id ?? null);
    expect(after.find((r) => r.row_id === entry.id)!.reason).toBe("signature_mismatch");
  });

  // Key order carries no meaning in JSONB — Postgres normalises it on write,
  // so it is not an attacker-controlled channel. Re-ordering must therefore
  // NOT trip tamper detection; that false positive is the whole defect.
  it("does not report tampering when only the key order differs", async () => {
    const entry = await auditService.log({
      action: "review.decided",
      actor: "reviewer:reorder@example.com",
      resource_type: "review",
      resource_id: "00000000-0000-0000-0000-000000000044",
      details: { zulu: "z", alpha: "a", mike: "m" },
    });

    await db
      .update(auditLog)
      .set({ details: { alpha: "a", mike: "m", zulu: "z" } as any })
      .where(eq(auditLog.id, entry.id));

    const after = await auditService.verify(entry.project_id ?? null);
    expect(after.find((r) => r.row_id === entry.id)!.reason).toBe("valid");
  });

  it("AuditService.query filters by action", async () => {
    // Insert entries with distinct actions
    await auditService.log({
      action: "template.created",
      actor: "system",
      resource_type: "template",
      details: { slug: "filter-test" },
    });

    const result = await auditService.query({ action: "template.created" });
    expect(result.items.length).toBeGreaterThan(0);
    result.items.forEach((item: any) => {
      expect(item.action).toBe("template.created");
    });
  });

  it("AuditService.query filters by several actions at once", async () => {
    await auditService.log({
      action: "template.updated",
      actor: "system",
      resource_type: "template",
      details: { slug: "filter-test-multi-a" },
    });
    await auditService.log({
      action: "template.deleted",
      actor: "system",
      resource_type: "template",
      details: { slug: "filter-test-multi-b" },
    });

    const result = await auditService.query({ action: ["template.updated", "template.deleted"] });
    expect(result.items.some((i: any) => i.action === "template.updated")).toBe(true);
    expect(result.items.some((i: any) => i.action === "template.deleted")).toBe(true);
    result.items.forEach((item: any) => {
      expect(["template.updated", "template.deleted"]).toContain(item.action);
    });
  });

  it("AuditService.query filters by resource_type", async () => {
    await auditService.log({
      action: "project.created",
      actor: "system",
      resource_type: "project",
      details: { name: "test" },
    });

    const result = await auditService.query({ resource_type: "project" });
    expect(result.items.length).toBeGreaterThan(0);
    result.items.forEach((item: any) => {
      expect(item.resource_type).toBe("project");
    });
  });

  it("GET /api/v1/audit returns audit entries", async () => {
    // Ensure at least one entry exists
    await auditService.log({
      action: "settings.changed",
      actor: "system",
      resource_type: "project",
      details: { key: "api-test" },
    });

    const res = await request(app).get("/api/v1/audit").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.items).toBeDefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("Review creation triggers audit log entry", async () => {
    // Create a review via API
    const createRes = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: "audit-test",
        payload: { content: "Audit integration test" },
        callback_url: "https://example.com/webhook",
      });
    expect(createRes.status).toBe(201);

    // Wait briefly for the async audit log to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Query audit log for this review
    const auditRes = await request(app)
      .get("/api/v1/audit")
      .query({ resource_type: "review", resource_id: createRes.body.id })
      .set(auth());

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.items.length).toBeGreaterThan(0);

    const auditEntry = auditRes.body.items.find(
      (e: any) => e.action === "review.created" && e.resource_id === createRes.body.id
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry.actor).toContain("agent:");
    expect(auditEntry.resource_type).toBe("review");
  });
});
