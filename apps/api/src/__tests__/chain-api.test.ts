import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { eq } from "drizzle-orm";

// HTTP surface for M10 chain routes. Exercises the three endpoints mounted
// under the dualRouter:
//   POST /api/v1/chain-runs
//   GET  /api/v1/chain-runs/:id
//   GET  /api/v1/reviews/:id/chain

describe("Chain HTTP API", () => {
  let app: any;
  let apiKey: string;
  let db: any;
  let projectId: string;
  let templateSlugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    templateSlugs = ["chain_api_tpl_1", "chain_api_tpl_2"];
    for (const slug of templateSlugs) {
      await db.insert(templates).values({
        id: generateId("template"),
        slug,
        project_id: projectId,
        name: slug,
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    }

    app = createApp({ db });
  });

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });
  const validBody = () => ({
    definition: {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [
        { id: "s1", template: templateSlugs[0], assignee: { kind: "user", email: "alice@x.com" } },
        { id: "s2", template: templateSlugs[1], assignee: { kind: "user", email: "bob@x.com" } },
      ],
    },
    initial_payload: { content: "kickoff" },
  });

  it("POST /api/v1/chain-runs returns 201 + envelope with chain_run + steps", async () => {
    const res = await request(app).post("/api/v1/chain-runs").set(auth()).send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.object).toBe("chain_run");
    expect(res.body.id).toMatch(/^gw_chain_/);
    expect(res.body.status).toBe("active");
    expect(res.body.mode).toBe("sequential");
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps[0].status).toBe("active");
    expect(res.body.steps[1].status).toBe("pending");
    expect(res.body.step_1_review_id).toMatch(/^gw_rev_/);
  });

  it("POST /api/v1/chain-runs rejects mode='parallel' with 422 feature_not_in_edition", async () => {
    const body = validBody();
    body.definition.mode = "parallel" as any;
    const res = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
    expect(res.status).toBe(422);
  });

  it("V13b-SMOKE — POST /api/v1/chain-runs rejects auth_level='account' step with 422 in OSS", async () => {
    const body = {
      definition: {
        version: "1.0",
        mode: "sequential",
        rejection_policy: "terminate",
        steps: [
          {
            id: "s1",
            template: templateSlugs[0],
            assignee: { kind: "external_token", auth_level: "account", auth_user_id: "user_xyz" },
          },
        ],
      },
      initial_payload: { content: "kickoff" },
    };
    const res = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
    expect(res.status).toBe(422);
  });

  it("POST /api/v1/chain-runs rejects unknown template with 400 template_not_found", async () => {
    // 400, not 422 — the template-exists check is DB-backed (not a zod rule),
    // so it surfaces as InvalidRequestError (status 400), not a validate-middleware
    // 422. The zod schema only enforces the shape; existence requires the DB.
    // C1: the ENTRY template is what must exist. A later step's `template` is
    // retired and ignored, so pointing step 1 (the entry fallback) at a missing
    // slug is what this route now refuses.
    const body = validBody();
    body.definition.steps[0].template = "does-not-exist";
    const res = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body?.error?.code || res.body?.code).toBe("template_not_found");
  });

  it("POST /api/v1/chain-runs rejects a private-address callback_url (SSRF guard)", async () => {
    // Mirrors the SSRF guard on POST /api/v1/reviews — a chain run must not
    // be creatable with a callback_url pointing at the cloud metadata
    // service or another private/reserved address. IP literal (not a
    // hostname) so the sync check fires without needing DNS mocking.
    const body = { ...validBody(), callback_url: "http://169.254.169.254/latest/meta-data/" };
    const res = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body?.error?.code || res.body?.code).toBe("invalid_callback_url");
  });

  it("POST /api/v1/chain-runs without auth returns 401", async () => {
    const res = await request(app).post("/api/v1/chain-runs").send(validBody());
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/chain-runs/:id returns the chain_run + steps", async () => {
    const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(validBody());
    const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.steps).toHaveLength(2);
  });

  it("GET /api/v1/chain-runs/:id returns 404 for unknown id", async () => {
    const res = await request(app).get("/api/v1/chain-runs/gw_chain_does-not-exist").set(auth());
    expect(res.status).toBe(404);
  });

  it("GET /api/v1/reviews/:id/chain returns chain context for a chain-attached review", async () => {
    const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(validBody());
    const reviewId = created.body.step_1_review_id;

    const res = await request(app).get(`/api/v1/reviews/${reviewId}/chain`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.current_step_number).toBe(1);
    expect(res.body.steps).toHaveLength(2);
    // E: name field must be projected from assignee_spec for the ChainStepper
    // frontend consumer. Steps in validBody() have no name, so name === null.
    expect(res.body.steps[0].name).toBeNull();
    expect(res.body.steps[1].name).toBeNull();
  });

  it("GET /api/v1/reviews/:id/chain projects step name from assignee_spec", async () => {
    const body = {
      definition: {
        version: "1.0",
        mode: "sequential",
        rejection_policy: "terminate",
        steps: [
          { id: "s1", name: "Legal review", template: templateSlugs[0], assignee: { kind: "user", email: "alice@x.com" } },
          { id: "s2", name: "Final approval", template: templateSlugs[1], assignee: { kind: "user", email: "bob@x.com" } },
        ],
      },
      initial_payload: { content: "named-steps" },
    };
    const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
    expect(created.status).toBe(201);
    const reviewId = created.body.step_1_review_id;

    const res = await request(app).get(`/api/v1/reviews/${reviewId}/chain`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.steps[0].name).toBe("Legal review");
    expect(res.body.steps[1].name).toBe("Final approval");
  });

  it("GET /api/v1/reviews/:id/chain returns 404 for a non-chain review", async () => {
    // Create a standalone review via the normal POST /reviews flow
    const reviewRes = await request(app).post("/api/v1/reviews").set(auth()).send({
      template: templateSlugs[0],
      payload: { content: "standalone" },
    });
    expect(reviewRes.status).toBe(201);

    const res = await request(app).get(`/api/v1/reviews/${reviewRes.body.id}/chain`).set(auth());
    expect(res.status).toBe(404);
  });

  // FS-PROJ-1 — future-step PII scrub projection coverage.
  // A NON-owner reviewer GET sees {kind} only on a pending step's assignee_spec.assignee.
  // An active step retains its (PII-scrubbed) full spec.
  describe("future-step assignee scrub (FS-PROJ)", () => {
    let fsTemplateSlug: string;

    beforeAll(async () => {
      fsTemplateSlug = "fsproj_tpl";
      await db.insert(templates).values({
        id: generateId("template"),
        slug: fsTemplateSlug,
        project_id: projectId,
        name: fsTemplateSlug,
        fields: [{ name: "content", type: "text", label: "Content" }],
        actions: ["approve", "reject"],
      });
    });

    it("FS-PROJ-1 — API-key caller sees {kind} on pending step, full spec on active step", async () => {
      // 2-step chain: step 1 active (external_token), step 2 pending (user)
      const body = {
        definition: {
          version: "1.0" as const,
          mode: "sequential" as const,
          rejection_policy: "terminate" as const,
          steps: [
            {
              id: "s1",
              template: fsTemplateSlug,
              assignee: { kind: "external_token" as const },
            },
            {
              id: "s2",
              template: fsTemplateSlug,
              assignee: { kind: "user" as const, email: "bob@example.com" },
            },
          ],
        },
        initial_payload: { content: "kickoff" },
      };
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
      expect(created.status).toBe(201);
      const chainId = created.body.id;

      // API-key caller: non-privileged (kind-only on pending, full on active)
      const res = await request(app).get(`/api/v1/chain-runs/${chainId}`).set(auth());
      expect(res.status).toBe(200);
      // Step 1 is active (external_token) — full spec retained (minus PII from scrubAssigneeSpecPii)
      const step1AssigneeSpec = res.body.steps[0].assignee_spec;
      expect(step1AssigneeSpec.assignee.kind).toBe("external_token");
      // Step 2 is pending — assignee identity scrubbed to {kind} only
      const step2AssigneeSpec = res.body.steps[1].assignee_spec;
      expect(step2AssigneeSpec.assignee).toEqual({ kind: "user" });
      expect(step2AssigneeSpec.assignee.email).toBeUndefined();
    });
  });

  // H1 — token_status projection coverage on the chain envelope GET path.
  // Exercises buildTokenStatusByReviewId end-to-end: the projection drives
  // a small lifecycle badge in the chain timeline UI, so any drift between
  // deriveTokenStatus + the route projection silently breaks the badge.
  describe("token_status projection (T-PROJ)", () => {
    let extTokenSlug: string;
    let userSlug: string;

    beforeAll(async () => {
      extTokenSlug = "tproj_ext_tpl";
      userSlug = "tproj_user_tpl";
      for (const slug of [extTokenSlug, userSlug]) {
        await db.insert(templates).values({
          id: generateId("template"),
          slug,
          project_id: projectId,
          name: slug,
          fields: [{ name: "content", type: "text", label: "Content" }],
          actions: ["approve", "reject"],
          enable_review_links: true,
          default_auth_level: "public",
          default_expiry_seconds: 86400,
        });
      }
    });

    function extTokenChainBody() {
      return {
        definition: {
          version: "1.0" as const,
          mode: "sequential" as const,
          rejection_policy: "terminate" as const,
          steps: [
            { id: "s1", template: extTokenSlug, assignee: { kind: "external_token" as const } },
          ],
        },
        initial_payload: { content: "kickoff" },
      };
    }

    it("T-PROJ-1 — external_token step surfaces token_status='active' after materialisation", async () => {
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(extTokenChainBody());
      expect(created.status).toBe(201);
      const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.steps[0].token_status).toBe("active");
    });

    it("T-PROJ-2 — revoking the token surfaces token_status='revoked' on re-fetch", async () => {
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(extTokenChainBody());
      const reviewId = created.body.step_1_review_id;
      const revoke = await request(app)
        .post(`/api/v1/reviews/${reviewId}/token/revoke`)
        .set(auth());
      expect(revoke.status).toBe(200);
      const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
      expect(res.body.steps[0].token_status).toBe("revoked");
    });

    it("T-PROJ-3 — consuming the token (approved) surfaces token_status='approved' on re-fetch", async () => {
      const { reviewTokens } = await import("@gatewerk/db/src/schema/index");
      const { eq } = await import("drizzle-orm");
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(extTokenChainBody());
      const reviewId = created.body.step_1_review_id;
      // Simulate consume: stamp used_at + decision='approved' directly on
      // the token row (the real /r/:token decision flow exercises the
      // same row update; we hit the projection from the persisted shape).
      await db.update(reviewTokens).set({
        used_at: new Date(),
        decision: "approved",
      }).where(eq(reviewTokens.review_id, reviewId));
      const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
      expect(res.body.steps[0].token_status).toBe("approved");
    });

    it("T-PROJ-4 — chain step with no review_id surfaces token_status=null", async () => {
      // 2-step chain where step 2 hasn't materialised yet (review_id=null
      // until step 1 is approved). Projection returns null, not 'active'.
      const body = {
        definition: {
          version: "1.0" as const,
          mode: "sequential" as const,
          rejection_policy: "terminate" as const,
          steps: [
            { id: "s1", template: userSlug, assignee: { kind: "user" as const, email: "alice@x.com" } },
            { id: "s2", template: extTokenSlug, assignee: { kind: "external_token" as const } },
          ],
        },
        initial_payload: { content: "kickoff" },
      };
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
      expect(created.status).toBe(201);
      const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
      expect(res.body.steps[1].review_id).toBeNull();
      expect(res.body.steps[1].token_status).toBeNull();
    });

    it("T-PROJ-5 — non-external_token step (kind=user) with review_id surfaces token_status=null", async () => {
      const body = {
        definition: {
          version: "1.0" as const,
          mode: "sequential" as const,
          rejection_policy: "terminate" as const,
          steps: [
            { id: "s1", template: userSlug, assignee: { kind: "user" as const, email: "alice@x.com" } },
          ],
        },
        initial_payload: { content: "kickoff" },
      };
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
      const res = await request(app).get(`/api/v1/chain-runs/${created.body.id}`).set(auth());
      expect(res.body.steps[0].review_id).toBeTruthy();
      expect(res.body.steps[0].token_status).toBeNull();
    });
  });

  // C1 relay (charter §3): a step-2 reviewer must be able to state step 1's
  // verdict, decider and note without leaving their own review. The API is where
  // that starts — until now a step's decision lived only on its own review row,
  // which a later reviewer has no reason to go looking for.
    describe("GET /reviews/:id/chain — the relay", () => {
    it("carries the prior step's decision and leaves future steps null", async () => {
      const body = validBody();
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
      expect(created.status).toBe(201);
      const runId = created.body.id;
      const step1ReviewId = created.body.steps[0].review_id;

      await db
        .update(reviews)
        .set({
          status: "decided",
          decision: "approved",
          decided_by: "junior@corp.co",
          decided_at: new Date(),
          feedback: "Numbers check out",
          updated_at: new Date(),
        })
        .where(eq(reviews.id, step1ReviewId));

      const res = await request(app).get(`/api/v1/reviews/${step1ReviewId}/chain`).set(auth());
      expect(res.status).toBe(200);
      const steps = res.body.steps;
      expect(steps[0].decision).toBe("approved");
      expect(steps[0].decided_by).toBe("junior@corp.co");
      expect(steps[0].feedback).toBe("Numbers check out");
      expect(steps[0].decided_at).toEqual(expect.any(String));
      // A step that has not decided contributes nothing.
      expect(steps[1].decision).toBeNull();
      expect(steps[1].decided_by).toBeNull();
      expect(runId).toBeTruthy();
    });

    it("does not surface a decision for a review that has not reached one", async () => {
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(validBody());
      const step1ReviewId = created.body.steps[0].review_id;
      // A draft is not a judgment.
      await db
        .update(reviews)
        .set({ draft_payload: { content: "half typed" }, draft_by: "junior@corp.co" })
        .where(eq(reviews.id, step1ReviewId));

      const res = await request(app).get(`/api/v1/reviews/${step1ReviewId}/chain`).set(auth());
      expect(res.body.steps[0].decision).toBeNull();
    });

    it("projects each step's guidance", async () => {
      const body = validBody();
      (body.definition.steps[0] as Record<string, unknown>).description =
        "Confirm the vendor is on the approved list";
      const created = await request(app).post("/api/v1/chain-runs").set(auth()).send(body);
      const step1ReviewId = created.body.steps[0].review_id;

      const res = await request(app).get(`/api/v1/reviews/${step1ReviewId}/chain`).set(auth());
      expect(res.body.steps[0].guidance).toBe("Confirm the vendor is on the approved list");
      expect(res.body.steps[1].guidance).toBeNull();
    });
    });
});
