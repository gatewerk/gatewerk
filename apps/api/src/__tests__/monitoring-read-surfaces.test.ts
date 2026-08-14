// HOTL monitoring gate — read surfaces: feedback exclusion + three-outcome stats. Verifies:
//   • window-lapsed confirmations excluded from the feedback endpoint
//   • outcome query param filter works for 'vetoed'
//   • template stats break out vetoed / confirmed_human / window_elapsed
//   • avg_review_time_ms in stats excludes lapse (system-actor) decisions

import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { templates, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";

const MON_SLUG = "mon-read-tpl";

describe("monitoring read surfaces", () => {
  let app: any;
  let db: any;
  let projectId: string;
  let apiKey: string;
  let templateId: string;

  // IDs of the 3 monitoring reviews seeded in beforeAll
  let lapsedId: string;
  let humanConfirmedId: string;
  let vetedId: string;

  // IDs of the 2 blocking decided reviews (for avg test)
  let blockingId1: string;
  let blockingId2: string;

  const auth = () => ({ Authorization: `Bearer ${apiKey}` });

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
    apiKey = seed.apiKey;

    // Insert the monitoring-enabled template
    const [tpl] = await db.insert(templates).values({
      id: generateId("template"),
      slug: MON_SLUG,
      project_id: projectId,
      name: "Monitoring Read Template",
      fields: [{ name: "content", type: "text", label: "Content" }],
      actions: ["approve", "reject"],
      allow_monitoring: true,
      auto_approve: false,
    }).returning();
    templateId = tpl.id;

    // Seed 2 blocking decided reviews with known created_at / decided_at
    // so the avg test can assert an exact value independent of lapse rows.
    // Review 1: decided in exactly 1 h (3 600 000 ms)
    const b1Created = new Date("2026-06-01T10:00:00Z");
    const b1Decided = new Date("2026-06-01T11:00:00Z");
    const [b1] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "blocking-1" },
      status: "decided",
      decision: "approved",
      decided_by: "human@example.com",
      decided_at: b1Decided,
      created_at: b1Created,
      updated_at: b1Decided,
    }).returning();
    blockingId1 = b1.id;

    // Review 2: decided in exactly 2 h (7 200 000 ms)
    const b2Created = new Date("2026-06-01T12:00:00Z");
    const b2Decided = new Date("2026-06-01T14:00:00Z");
    const [b2] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "blocking-2" },
      status: "decided",
      decision: "rejected",
      decided_by: "human@example.com",
      decided_at: b2Decided,
      created_at: b2Created,
      updated_at: b2Decided,
    }).returning();
    blockingId2 = b2.id;

    // Monitoring review 1 — window lapsed: auto-confirmed by worker
    // (decided_by = 'system:monitoring_window') — must be EXCLUDED from feedback
    const lapseNow = new Date("2026-06-01T08:00:00Z");
    const lapseExpires = new Date("2026-06-01T08:05:00Z"); // 5 min window
    const [lapsed] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "lapsed" },
      callback_url: "https://agent.example/cb",
      status: "decided",
      oversight: "monitoring",
      irreversibility: "reversible",
      expires_at: lapseExpires,
      decision: "confirmed",
      decided_by: "system:monitoring_window",
      decided_at: lapseExpires,
      created_at: lapseNow,
      updated_at: lapseExpires,
    }).returning();
    lapsedId = lapsed.id;

    // Monitoring review 2 — human confirmed within the window
    const hcNow = new Date("2026-06-01T09:00:00Z");
    const hcDecided = new Date("2026-06-01T09:02:00Z");
    const [humanConfirmed] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "human-confirmed" },
      callback_url: "https://agent.example/cb",
      status: "decided",
      oversight: "monitoring",
      irreversibility: "reversible",
      expires_at: new Date("2026-06-01T09:10:00Z"),
      decision: "confirmed",
      decided_by: "reviewer@example.com",
      decided_at: hcDecided,
      created_at: hcNow,
      updated_at: hcDecided,
    }).returning();
    humanConfirmedId = humanConfirmed.id;

    // Monitoring review 3 — vetoed by a human
    const vNow = new Date("2026-06-01T07:00:00Z");
    const vDecided = new Date("2026-06-01T07:03:00Z");
    const [vetoed] = await db.insert(reviewsTable).values({
      id: generateId("review"),
      project_id: projectId,
      template_id: templateId,
      template_slug: MON_SLUG,
      payload: { msg: "vetoed" },
      callback_url: "https://agent.example/cb",
      status: "decided",
      oversight: "monitoring",
      irreversibility: "reversible",
      expires_at: new Date("2026-06-01T07:10:00Z"),
      decision: "vetoed",
      decided_by: "reviewer@example.com",
      decided_at: vDecided,
      created_at: vNow,
      updated_at: vDecided,
    }).returning();
    vetedId = vetoed.id;

    app = createApp({ db, eventBus: new EventBus() });
  });

  // ——————————————————————————————————————————
  // F1: feedback excludes lapsed, includes human confirms and vetoes
  // ——————————————————————————————————————————
  it("feedback excludes window-lapsed confirmations but includes human confirms and vetoes", async () => {
    const res = await request(app)
      .get("/api/v1/feedback")
      .set(auth());

    expect(res.status).toBe(200);

    const ids = res.body.items.map((i: any) => i.review_id);

    // Human confirmed and vetoed must be present
    expect(ids).toContain(humanConfirmedId);
    expect(ids).toContain(vetedId);

    // Lapsed auto-confirm must be absent (spec §4.5: not a human signal)
    expect(ids).not.toContain(lapsedId);
  });

  // ——————————————————————————————————————————
  // F2: outcome query param filters to 'vetoed' only
  // ——————————————————————————————————————————
  it("feedback outcome filter works for the new decisions", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?outcome=vetoed")
      .set(auth());

    expect(res.status).toBe(200);

    const ids = res.body.items.map((i: any) => i.review_id);
    expect(ids).toContain(vetedId);
    expect(ids).not.toContain(humanConfirmedId);
    expect(ids).not.toContain(lapsedId);
    // Blocking reviews have decision approved/rejected — also absent
    expect(ids).not.toContain(blockingId1);
    expect(ids).not.toContain(blockingId2);
  });

  // ——————————————————————————————————————————
  // S1: template stats reports the three monitoring outcomes distinctly
  // ——————————————————————————————————————————
  it("template stats report vetoed / confirmed_human / window_elapsed distinctly", async () => {
    const res = await request(app)
      .get(`/api/v1/templates/${templateId}/stats`)
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.vetoed).toBe(1);
    expect(res.body.confirmed_human).toBe(1);
    expect(res.body.window_elapsed).toBe(1);
  });

  // ——————————————————————————————————————————
  // A1: avg_review_time_ms must exclude system-actor (lapse) decisions
  // ——————————————————————————————————————————
  it("avg response-time aggregates exclude the lapse actor", async () => {
    // Human-decided rows (decided_by NOT LIKE 'system%') included in avg:
    //   b1 (blocking):         1 h  = 3 600 000 ms
    //   b2 (blocking):         2 h  = 7 200 000 ms
    //   human-confirmed (mon): 2 min =   120 000 ms
    //   vetoed (mon):          3 min =   180 000 ms
    //   → avg = 11 100 000 / 4 = 2 775 000 ms
    //
    // The lapsed monitoring row (decided_by='system:monitoring_window') must
    // be excluded. Its decision-time is 5 min = 300 000 ms. If included it
    // would shift avg to 11 400 000 / 5 = 2 280 000 ms — a different value.
    const expectedAvgMs = Math.round((3_600_000 + 7_200_000 + 120_000 + 180_000) / 4); // 2 775 000

    const res = await request(app)
      .get("/api/v1/stats")
      .set(auth());

    expect(res.status).toBe(200);
    expect(res.body.avg_review_time_ms).toBe(expectedAvgMs);
  });
});
