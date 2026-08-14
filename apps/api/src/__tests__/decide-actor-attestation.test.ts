/**
 * POST /reviews/:id/decide must attribute the decision to the AUTHENTICATED
 * caller, never to whoever the request body names.
 *
 * The legacy alias used to let `body.reviewer` win over the session identity.
 * The consequence was not a broken signature — it was a correct signature over
 * a false statement. An authenticated user could attribute their decision to a
 * colleague, the chain would sign it, and verify() would return valid, because
 * nothing had been tampered with: the row was a lie on the way in.
 *
 * For a product whose claim is "the record cannot be forged", that is the one
 * hole that matters, so this is a regression net rather than a nicety.
 */

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";
import { createTestDb, seedTestProject, seedReviewer } from "./helpers/test-db";
import { templates } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";

type Row = {
  action: string;
  actor: string;
  resource_id?: string;
  details?: Record<string, unknown>;
};

describe("POST /decide — actor attestation", () => {
  let app: Express;
  let db: any;
  let apiKey: string;
  let sessionToken: string;
  const rows: Row[] = [];

  const OWN_EMAIL = "decider@attest.test";
  const SOMEONE_ELSE = "someone.else@customer.com";

  async function createReview(): Promise<string> {
    const res = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ template: "attest-tpl", payload: { task: "x" } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  beforeAll(async () => {
    const setup = await createTestDb();
    db = setup.db;
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;

    await db.insert(templates).values({
      id: generateId("template"),
      slug: "attest-tpl",
      project_id: seed.project.id,
      name: "Attest Template",
      fields: [{ name: "task", type: "text", label: "Task" }],
      actions: ["approve", "reject"],
    });

    const audit = {
      async log(d: Row) {
        rows.push(d);
        return { id: generateId("event"), ...d };
      },
      logBestEffort(d: Row) {
        rows.push(d);
      },
      async verify() {
        return [];
      },
      async query() {
        return { items: [], total: 0, has_more: false };
      },
    };
    app = createApp({ db, auditService: audit as any });

    const seeded = await seedReviewer(db, app, {
      email: OWN_EMAIL,
      role: "admin",
      name: "Decider",
    });
    sessionToken = seeded.sessionToken;
  });

  it("does not let a session caller attribute a decision to someone else", async () => {
    const reviewId = await createReview();
    rows.length = 0;

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ decision: "approved", reviewer: SOMEONE_ELSE });
    expect(res.status).toBe(200);

    const written = rows.filter((r) => r.resource_id === reviewId);
    expect(written.length).toBeGreaterThan(0);

    // Not one audit row may name the impersonated party as the actor.
    for (const row of written) {
      expect(row.actor).not.toContain(SOMEONE_ELSE);
      expect(row.actor).toContain(OWN_EMAIL);
    }

    // The stored decision must also carry the real identity, since the ledger
    // UI and the SDK both read decided_by rather than the audit row.
    expect(res.body.decided_by).toBe(OWN_EMAIL);
    expect(res.body.decided_by).not.toBe(SOMEONE_ELSE);
  });

  it("records what the caller attested, so their intent is not simply discarded", async () => {
    const reviewId = await createReview();
    rows.length = 0;

    await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ decision: "approved", reviewer: SOMEONE_ELSE });

    const decided = rows.find(
      (r) => r.resource_id === reviewId && r.action === "review.decided",
    );
    expect(decided).toBeDefined();
    expect(decided!.details?.attested_reviewer).toBe(SOMEONE_ELSE);
  });

  it("omits attested_reviewer when the caller names only themselves", async () => {
    const reviewId = await createReview();
    rows.length = 0;

    await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${sessionToken}`)
      .send({ decision: "approved", reviewer: OWN_EMAIL });

    const decided = rows.find(
      (r) => r.resource_id === reviewId && r.action === "review.decided",
    );
    expect(decided).toBeDefined();
    // The field exists to flag a divergence. Emitting it when there is none
    // would train a reader to ignore it.
    expect(decided!.details).not.toHaveProperty("attested_reviewer");
  });

  it("still lets an API key record a named human in decided_by", async () => {
    // The api-key path never consulted the body override for the AUDIT actor —
    // it stays agent:<prefix> — but it does set decided_by, which is how an
    // agent records that a named person made the call. That behaviour is
    // deliberate and unchanged.
    const reviewId = await createReview();
    rows.length = 0;

    const res = await request(app)
      .post(`/api/v1/reviews/${reviewId}/decide`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ decision: "approved", reviewer: SOMEONE_ELSE });
    expect(res.status).toBe(200);
    expect(res.body.decided_by).toBe(SOMEONE_ELSE);

    const written = rows.filter((r) => r.resource_id === reviewId);
    for (const row of written) {
      expect(row.actor).toMatch(/^agent:/);
    }
  });
});
