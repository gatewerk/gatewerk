import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "../__tests__/helpers/test-db";
import { organizations } from "@gatewerk/db";
import { isTenantPaused } from "../services/email/pause";

function makeAuditService(): any {
  return { log: vi.fn(async () => {}) };
}

describe("admin email pause routes", () => {
  let app: any;
  let client: any;
  let db: any;
  let adminToken: string;
  let adminReviewerId: string;
  let reviewerToken: string;
  let auditService: any;
  const pausedOrgId = "org-paused-1";
  const pauseReason = "bounce rate 0.20 over 50 sends in 24h";

  beforeAll(async () => {
    const testDb = await createTestDb();
    client = testDb.client;
    db = testDb.db;
    await seedTestProject(db);
    auditService = makeAuditService();
    app = createApp({ db, auditService: auditService as any });

    await db.insert(organizations).values({
      id: pausedOrgId,
      name: "Paused Org",
      slug: "paused-org",
      email_paused_at: new Date(),
      email_pause_reason: pauseReason,
    });
    await db.insert(organizations).values({
      id: "org-healthy-1",
      name: "Healthy Org",
      slug: "healthy-org",
    });

    const admin = await seedReviewer(db, app, {
      email: "admin-email-pause@test.local",
      password: "password123",
      role: "admin",
    });
    adminToken = admin.sessionToken;
    adminReviewerId = admin.reviewer.id;

    const reviewer = await seedReviewer(db, app, {
      email: "reviewer-email-pause@test.local",
      password: "password123",
      role: "reviewer",
    });
    reviewerToken = reviewer.sessionToken;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  it("lists a paused organization, including its reason, for an admin session", async () => {
    const res = await request(app)
      .get("/api/v1/admin/email-pause")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const found = res.body.organizations.find((o: any) => o.id === pausedOrgId);
    expect(found).toBeTruthy();
    expect(found.email_pause_reason).toBe(pauseReason);
    expect(res.body.organizations.some((o: any) => o.id === "org-healthy-1")).toBe(false);
  });

  it("clears the pause on resume and audits it", async () => {
    expect(await isTenantPaused(db, pausedOrgId)).toBe(true);

    const res = await request(app)
      .post(`/api/v1/admin/email-pause/${pausedOrgId}/resume`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(await isTenantPaused(db, pausedOrgId)).toBe(false);

    // The resume is audited, so a human-initiated unpause is traceable —
    // fire-and-forget in the route, but the write itself must still happen.
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "email.tenant_resumed",
        actor: adminReviewerId,
        resource_type: "organization",
        resource_id: pausedOrgId,
      }),
    );
  });

  it("returns 404 for resuming an unknown organization", async () => {
    const res = await request(app)
      .post("/api/v1/admin/email-pause/no-such-org/resume")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    // Checking the error code, not just the status, matters here: an
    // unmounted route would also 404, but Express's own default 404 response
    // carries no JSON body at all, so it could never produce this code.
    expect(res.body.error.code).toBe("organization_not_found");
  });

  it("returns 401 without a session", async () => {
    const res = await request(app).get("/api/v1/admin/email-pause");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin reviewer session", async () => {
    const res = await request(app)
      .get("/api/v1/admin/email-pause")
      .set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(403);
  });
});
