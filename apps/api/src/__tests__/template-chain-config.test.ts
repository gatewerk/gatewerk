import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates as templatesTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

// M12 — chain_config JSONB on templates. Backend exercises:
//  * Templates POST/PUT round-trip chain_config through validate middleware
//  * PATCH semantics: undefined leaves untouched, null clears, object replaces
//  * Zod refinements catch invalid definitions at write time
//  * POST /reviews against a chain_config-bearing template auto-spawns a
//    chain_run via ChainEngine.createRun, with the new review as step 1
//  * chain_config + assignment_ladder is a 400 (mutually exclusive routing
//    mechanisms — combining them produces non-deterministic step ownership)

describe("Templates with chain_config", () => {
  let app: any;
  let apiKey: string;
  let db: any;
  let projectId: string;
  let stepTemplateSlugs: string[];

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;

    // Step-target templates referenced by chain_config.steps[].template. These
    // are separate from the chain-bearing template under test — every step in
    // a chain materializes a review against an existing template slug.
    stepTemplateSlugs = ["m12_step_one", "m12_step_two", "m12_step_three"];
    for (const slug of stepTemplateSlugs) {
      await db.insert(templatesTable).values({
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

  function validChainConfig() {
    return {
      version: "1.0" as const,
      mode: "sequential" as const,
      rejection_policy: "terminate" as const,
      steps: [
        {
          id: "draft",
          template: stepTemplateSlugs[0],
          assignee: { kind: "user" as const, email: "drafter@example.com" },
        },
        {
          id: "review",
          template: stepTemplateSlugs[1],
          assignee: { kind: "user" as const, email: "reviewer@example.com" },
        },
      ],
    };
  }

  function validTemplateBody(slug: string, chain_config?: unknown) {
    const body: Record<string, unknown> = {
      slug,
      name: slug,
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
    };
    if (chain_config !== undefined) body.chain_config = chain_config;
    return body;
  }

  it("POST /templates with chain_config persists and round-trips on GET", async () => {
    const slug = "tpl-chain-create";
    const cfg = validChainConfig();
    const created = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody(slug, cfg));
    expect(created.status).toBe(201);
    expect(created.body.chain_config).toEqual(cfg);

    const fetched = await request(app)
      .get(`/api/v1/templates/${created.body.id}`)
      .set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.chain_config).toEqual(cfg);
  });

  it("POST /templates without chain_config leaves it null", async () => {
    const created = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody("tpl-chain-no-cfg"));
    expect(created.status).toBe(201);
    expect(created.body.chain_config).toBeNull();
  });

  it("PUT /templates/:id with chain_config=object replaces the value", async () => {
    const created = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody("tpl-chain-replace", validChainConfig()));
    expect(created.status).toBe(201);

    const replacement = validChainConfig();
    replacement.steps.push({
      id: "approve",
      template: stepTemplateSlugs[2],
      assignee: { kind: "user" as const, email: "approver@example.com" },
    });

    const updated = await request(app)
      .put(`/api/v1/templates/${created.body.id}`)
      .set(auth())
      .send({ chain_config: replacement });
    expect(updated.status).toBe(200);
    expect(updated.body.chain_config.steps).toHaveLength(3);
    expect(updated.body.chain_config.steps[2].id).toBe("approve");
  });

  it("PUT /templates/:id with chain_config=null clears the value", async () => {
    const created = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody("tpl-chain-clear", validChainConfig()));
    expect(created.status).toBe(201);
    expect(created.body.chain_config).not.toBeNull();

    const cleared = await request(app)
      .put(`/api/v1/templates/${created.body.id}`)
      .set(auth())
      .send({ chain_config: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.chain_config).toBeNull();
  });

  it("PUT /templates/:id without chain_config key leaves the existing value untouched", async () => {
    const cfg = validChainConfig();
    const created = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody("tpl-chain-untouched", cfg));
    expect(created.status).toBe(201);

    const updated = await request(app)
      .put(`/api/v1/templates/${created.body.id}`)
      .set(auth())
      .send({ description: "renamed" });
    expect(updated.status).toBe(200);
    expect(updated.body.chain_config).toEqual(cfg);
  });

  it("POST /templates with chain_config missing required steps[] is rejected by zod", async () => {
    const body = validTemplateBody("tpl-chain-invalid-empty", {
      version: "1.0",
      mode: "sequential",
      rejection_policy: "terminate",
      steps: [],
    });
    const res = await request(app).post("/api/v1/templates").set(auth()).send(body);
    expect(res.status).toBe(422);
  });

  it("POST /templates with rejection_policy='branch' but cycling rejection_branch_to is rejected", async () => {
    const cfg = validChainConfig();
    // branch_to MUST be < step_number; setting branch_to=2 on step 2 (1-based)
    // is a self-cycle and must be caught by zod refinement before persistence.
    cfg.steps[1] = {
      ...cfg.steps[1],
      rejection_policy: "branch" as const,
      rejection_branch_to: 2,
    } as any;
    const res = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody("tpl-chain-cycle", cfg));
    expect(res.status).toBe(422);
  });

  it("POST /reviews against a chain_config template spawns a chain_run with that review as step 1", async () => {
    // Set up: a template that carries chain_config. Step 1 of the chain
    // references the chain-carrying template's own slug, so the spawned
    // review's template_slug matches POSTing-template's slug.
    const slug = "tpl-chain-spawn";
    const cfg = {
      version: "1.0" as const,
      mode: "sequential" as const,
      rejection_policy: "terminate" as const,
      steps: [
        {
          id: "step_one",
          template: slug,
          assignee: { kind: "user" as const, email: "first@example.com" },
        },
        {
          id: "step_two",
          template: stepTemplateSlugs[1],
          assignee: { kind: "user" as const, email: "second@example.com" },
        },
      ],
    };
    const tplRes = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody(slug, cfg));
    expect(tplRes.status).toBe(201);

    const reviewRes = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({ template: slug, payload: { content: "kickoff" } });
    expect(reviewRes.status).toBe(201);
    expect(reviewRes.body.chain_run_id).toMatch(/^gw_chain_/);

    // Fetch the chain_run and confirm step 1 review id matches the new review.
    const chainRes = await request(app)
      .get(`/api/v1/chain-runs/${reviewRes.body.chain_run_id}`)
      .set(auth());
    expect(chainRes.status).toBe(200);
    expect(chainRes.body.steps).toHaveLength(2);
    expect(chainRes.body.steps[0].review_id).toBe(reviewRes.body.id);
    expect(chainRes.body.steps[0].step_number).toBe(1);
    expect(chainRes.body.steps[1].status).toBe("pending");
  });

  it("POST /reviews with both chain_config-bearing template AND assignment_ladder returns 400 chain_and_ladder_exclusive", async () => {
    const slug = "tpl-chain-ladder-conflict";
    const cfg = {
      version: "1.0" as const,
      mode: "sequential" as const,
      rejection_policy: "terminate" as const,
      steps: [
        {
          id: "only_step",
          template: slug,
          assignee: { kind: "user" as const, email: "drafter@example.com" },
        },
      ],
    };
    const tplRes = await request(app)
      .post("/api/v1/templates")
      .set(auth())
      .send(validTemplateBody(slug, cfg));
    expect(tplRes.status).toBe(201);

    const reviewRes = await request(app)
      .post("/api/v1/reviews")
      .set(auth())
      .send({
        template: slug,
        payload: { content: "x" },
        assignment_ladder: [
          { actor: "first@example.com", trigger_after_seconds: 600 },
        ],
      });
    expect(reviewRes.status).toBe(400);
    expect(reviewRes.body?.error?.code || reviewRes.body?.code).toBe("chain_and_ladder_exclusive");
  });
});
