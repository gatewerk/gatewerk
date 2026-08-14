import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from "vitest";
import request from "supertest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, projects } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { config } from "../config";

// Regression: the four route files and timeout worker used to silently fall
// back to config.hmacSecret (env) when a project's hmac_secret was NULL.
// Migration 019 made the column
// NOT NULL and the fallbacks were removed; this test locks in the property
// that outgoing webhook signatures derive from the PROJECT secret, never the
// env-level fallback. The chosen project secret intentionally differs from
// config.hmacSecret so that a revived fallback would fail the signature match.
//
// The fetch spy must be installed BEFORE createApp() — WebhookService captures
// `globalThis.fetch` once at construction, so later spies on the global have
// no effect on already-wired services.
describe("Webhook HMAC origin (regression: F3/ID6)", () => {
  let app: any;
  let apiKey: string;
  // MockInstance<typeof fetch>: ReturnType<typeof vi.spyOn> defaults to a
  // generic signature incompatible with fetch's overload set.
  let fetchSpy: MockInstance<typeof fetch>;
  const projectSecret = "project-specific-hmac-key-not-env-default"; // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key

  beforeAll(async () => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));

    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    await db
      .update(projects)
      .set({ hmac_secret: projectSecret })
      .where(eq(projects.id, seed.project.id));

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "hmac-origin-template",
      project_id: seed.project.id,
      name: "HMAC Origin Template",
      fields: [{ name: "content", type: "text", label: "Content", editable: true }],
      actions: ["approve", "reject"],
    });

    app = createApp({ db });
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  it("POST /reviews/:id/decide signs outbound webhook with project secret, not env secret", async () => {
    expect(projectSecret).not.toBe(config.hmacSecret);

    fetchSpy.mockClear();

    const createRes = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        template: "hmac-origin-template",
        payload: { content: "check hmac origin" },
        callback_url: "https://agent.example.com/callback",
      });
    expect(createRes.status).toBe(201);
    const reviewId = createRes.body.id;

    const decideRes = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ decision: "approved" });
    expect(decideRes.status).toBe(200);

    // Fire-and-forget webhook dispatch needs a tick to flush.
    await new Promise((r) => setTimeout(r, 30));

    const call = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes("agent.example.com/callback"),
    );
    expect(call).toBeDefined();

    const opts = call![1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    const sigHeader = headers["X-Webhook-Signature"];
    expect(sigHeader).toMatch(/^sha256=[0-9a-f]{64}$/);

    const bodyStr = String(opts.body);
    const sentHex = sigHeader.replace(/^sha256=/, "");

    const projectHex = createHmac("sha256", projectSecret).update(bodyStr).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(sentHex).toBe(projectHex);

    const envHex = createHmac("sha256", config.hmacSecret).update(bodyStr).digest("hex"); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    expect(sentHex).not.toBe(envHex);
  });
});
