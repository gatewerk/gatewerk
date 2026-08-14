import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { createApp } from "../app";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { EventBus } from "../services/events";
import { __resetConnectionCountsForTest } from "../services/sse-hub";

describe("POST /api/v1/events/ticket", () => {
  let app: any;
  let eventBus: EventBus;
  let apiKey: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    eventBus = new EventBus();
    app = createApp({ db, eventBus });
  });

  beforeEach(() => {
    __resetConnectionCountsForTest();
  });

  it("returns 401 without a Bearer token", async () => {
    const res = await request(app).post("/api/v1/events/ticket");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid bearer", async () => {
    const res = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: "Bearer gwk_invalid_key_xxx" });
    expect(res.status).toBe(401);
  });

  it("returns a ticket + expires_in for a valid API key", async () => {
    const res = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: `Bearer ${apiKey}` });
    expect(res.status).toBe(200);
    expect(typeof res.body.ticket).toBe("string");
    expect(res.body.ticket.length).toBeGreaterThan(30);
    expect(res.body.expires_in).toBeGreaterThan(0);
  });
});

describe("GET /api/v1/events/stream", () => {
  let app: any;
  let eventBus: EventBus;
  let apiKey: string;
  let projectId: string;

  beforeAll(async () => {
    const { db } = await createTestDb();
    const seed = await seedTestProject(db);
    apiKey = seed.apiKey;
    projectId = seed.project.id;
    eventBus = new EventBus();
    app = createApp({ db, eventBus });
  });

  beforeEach(() => {
    __resetConnectionCountsForTest();
  });

  it("rejects stream request with no ticket (401)", async () => {
    const res = await request(app).get("/api/v1/events/stream");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_ticket");
  });

  it("rejects stream request with invalid ticket (401)", async () => {
    const res = await request(app)
      .get("/api/v1/events/stream")
      .query({ ticket: "deadbeef" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_ticket");
  });

  it("rejects reuse of a consumed ticket (single-use semantics)", async () => {
    const issue = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: `Bearer ${apiKey}` });
    const ticket = issue.body.ticket;

    const stream = await openStream(app, ticket);
    stream.close();

    const second = await request(app)
      .get("/api/v1/events/stream")
      .query({ ticket });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("invalid_ticket");
  });

  it("delivers an opened frame followed by a real event emitted on the bus", async () => {
    const issue = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: `Bearer ${apiKey}` });
    const ticket = issue.body.ticket;

    const stream = await openStream(app, ticket);

    const openEvt = await stream.nextEvent();
    expect(openEvt).toEqual({ type: "open" });

    // A short delay ensures the subscription is registered before emit.
    await new Promise((r) => setTimeout(r, 10));

    eventBus.emit("review.created", {
      review_id: "gw_rev_live_1",
      template: "refund",
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    const created = await stream.nextEvent();
    expect(created).toMatchObject({
      type: "review.created",
      review_id: "gw_rev_live_1",
      project_id: projectId,
      template_slug: "refund",
    });

    stream.close();
  });

  it("filters out events from other projects for API-key subscribers", async () => {
    const issue = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: `Bearer ${apiKey}` });
    const ticket = issue.body.ticket;

    const stream = await openStream(app, ticket);
    await stream.nextEvent(); // open frame

    await new Promise((r) => setTimeout(r, 10));

    // Event for a different project — should not arrive on this stream.
    eventBus.emit("review.created", {
      review_id: "gw_rev_other",
      template: "refund",
      project_id: "gw_prj_OTHER",
      priority: "normal",
      created_at: new Date().toISOString(),
    });
    // A matching one — should arrive.
    eventBus.emit("review.created", {
      review_id: "gw_rev_own",
      template: "refund",
      project_id: projectId,
      priority: "normal",
      created_at: new Date().toISOString(),
    });

    const received = await stream.nextEvent();
    expect(received.review_id).toBe("gw_rev_own");

    stream.close();
  });

  it("returns 429 once the per-user connection cap is reached", async () => {
    // Pre-fill 5 slots for this user via fresh tickets.
    const streams: StreamHandle[] = [];
    for (let i = 0; i < 5; i++) {
      const issue = await request(app)
        .post("/api/v1/events/ticket")
        .set({ Authorization: `Bearer ${apiKey}` });
      streams.push(await openStream(app, issue.body.ticket));
    }

    const extra = await request(app)
      .post("/api/v1/events/ticket")
      .set({ Authorization: `Bearer ${apiKey}` });
    const sixth = await request(app)
      .get("/api/v1/events/stream")
      .query({ ticket: extra.body.ticket });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("too_many_connections");

    for (const s of streams) s.close();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

interface StreamHandle {
  nextEvent(): Promise<any>;
  close(): void;
}

async function openStream(app: any, ticket: string): Promise<StreamHandle> {
  return new Promise<StreamHandle>((resolve, reject) => {
    const server: Server = createServer(app).listen(0, async () => {
      try {
        const { port } = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${port}/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`;
        const controller = new AbortController();
        const response = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });

        if (response.status !== 200 || !response.body) {
          server.close();
          reject(new Error(`Stream opened with status ${response.status}`));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const queue: any[] = [];
        const waiters: Array<(v: any) => void> = [];

        const pump = async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let idx: number;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
                if (!dataLine) continue;
                const json = dataLine.slice(6);
                try {
                  const parsed = JSON.parse(json);
                  const waiter = waiters.shift();
                  if (waiter) waiter(parsed);
                  else queue.push(parsed);
                } catch {
                  /* skip malformed */
                }
              }
            }
          } catch {
            /* stream aborted */
          }
        };
        pump();

        const handle: StreamHandle = {
          nextEvent(timeoutMs = 2000) {
            return new Promise((res, rej) => {
              if (queue.length > 0) return res(queue.shift());
              const timer = setTimeout(() => rej(new Error("nextEvent timeout")), timeoutMs);
              waiters.push((v) => {
                clearTimeout(timer);
                res(v);
              });
            });
          },
          close() {
            controller.abort();
            server.close();
          },
        };
        resolve(handle);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

// Cleanup any leaked listeners.
afterAll(() => {
  __resetConnectionCountsForTest();
});
