import { describe, it, expect } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { requireScope } from "../middleware/require-scope";
import { tenantContext } from "../middleware/tenant";
import { createTestDb, seedTestProject } from "./helpers/test-db";

// Locks §7 G2: apiKeyAuth must be self-sufficient. requireScope →
// subjectFromRequest keys off req.authType, so apiKeyAuth has to set it.
// The happy path is exercised by /feedback /audit /webhooks/deliveries in
// the main app, but there dualAuth runs as outer middleware at /api/v1
// and happens to set authType first — masking apiKeyAuth's responsibility.
// This test mounts apiKeyAuth directly, without dualAuth upstream, to
// prove the middleware stands on its own.
describe("apiKeyAuth standalone (§7 G2 — no dualAuth upstream)", () => {
  it("populates authType='apikey' so requireScope accepts the subject", async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);

    const app = express();
    app.use(express.json());
    app.use(tenantContext());

    const router = Router();
    router.use(apiKeyAuth(db));
    router.get("/probe", requireScope("reviews:read"), (req, res) => {
      res.json({
        authType: (req as any).authType,
        projectId: (req as any).projectId,
        scopes: (req as any).scopes,
      });
    });
    app.use("/standalone", router);

    const res = await request(app)
      .get("/standalone/probe")
      .set("Authorization", `Bearer ${seed.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.authType).toBe("apikey");
    expect(res.body.projectId).toBe(seed.project.id);
  });

  it("still 401s when the key is invalid (auth short-circuits before scope)", async () => {
    const { db } = await createTestDb();
    await seedTestProject(db);

    const app = express();
    app.use(express.json());
    app.use(tenantContext());

    const router = Router();
    router.use(apiKeyAuth(db));
    router.get("/probe", requireScope("reviews:read"), (_req, res) => {
      res.json({ ok: true });
    });
    app.use("/standalone", router);
    // Error handler — otherwise next(err) hangs.
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? 500).json({ error: { code: err.code } });
    });

    const res = await request(app)
      .get("/standalone/probe")
      .set("Authorization", "Bearer gwk_not_a_real_key");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_api_key");
  });
});
