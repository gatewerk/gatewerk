import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedTestProject } from "./helpers/test-db";
import { notificationChannels } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import { EventBus } from "../services/events";
import { NotificationService } from "../services/notifications";

async function getChannel(db: any, id: string) {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id));
  return row;
}

describe("EventBus", () => {
  it("emits and receives events", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("review.created", handler);
    bus.emit("review.created", {
      review_id: "r1",
      template: "tpl",
      project_id: "p1",
      priority: "normal",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      review_id: "r1",
      template: "tpl",
      project_id: "p1",
      priority: "normal",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("does not call handlers for other events", () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("review.decided", handler);
    bus.emit("review.created", {
      review_id: "r1",
      template: "tpl",
      project_id: "p1",
      priority: "normal",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("NotificationService", () => {
  let db: any;
  let projectId: string;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    const seed = await seedTestProject(db);
    projectId = seed.project.id;
  });

  it("fires webhook for matching active channel", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    // Insert an active channel subscribed to review.created
    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Slack alerts",
      webhook_url: "https://hooks.example.com/slack",
      events: ["review.created", "review.decided"],
      headers: { "X-Custom": "test-header" },
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-abc",
      template: "email-review",
      project_id: projectId,
      priority: "high",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    // Allow async handler to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/slack");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["X-Custom"]).toBe("test-header");

    const body = JSON.parse(opts.body);
    expect(body.event).toBe("review.created");
    expect(body.review_id).toBe("r-abc");
    expect(body.priority).toBe("high");
  });

  it("skips inactive channels", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    // Insert an inactive channel
    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Disabled channel",
      webhook_url: "https://hooks.example.com/disabled",
      events: ["review.urgent"],
      is_active: false,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.urgent", {
      review_id: "r-xyz",
      template: "deploy-review",
      project_id: projectId,
      priority: "critical",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should not have been called for the disabled channel's URL
    const disabledCalls = mockFetch.mock.calls.filter(
      (c: any) => c[0] === "https://hooks.example.com/disabled",
    );
    expect(disabledCalls).toHaveLength(0);
  });

  it("skips channels not subscribed to the event", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    // Insert an active channel that only subscribes to review.expired
    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Expired-only channel",
      webhook_url: "https://hooks.example.com/expired-only",
      events: ["review.expired"],
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.retried", {
      review_id: "r-retry",
      template: "code-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-01-01T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Should not have been called for the expired-only channel
    const expiredOnlyCalls = mockFetch.mock.calls.filter(
      (c: any) => c[0] === "https://hooks.example.com/expired-only",
    );
    expect(expiredOnlyCalls).toHaveLength(0);
  });

  it("transforms payload for slack-type channel (Block Kit)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Slack Block Kit",
      webhook_url: "https://hooks.example.com/slack-block-kit",
      events: ["review.created"],
      type: "slack",
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-slack",
      template: "deploy-review",
      project_id: projectId,
      priority: "critical",
      created_at: "2026-05-19T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    const slackCall = mockFetch.mock.calls.find((c: any) => c[0] === "https://hooks.example.com/slack-block-kit");
    expect(slackCall).toBeDefined();
    const body = JSON.parse(slackCall![1].body);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.text).toBeTruthy();
    expect(body.event).toBeUndefined(); // generic shape stripped — Slack format only
    const button = body.blocks.find((b: any) => b.type === "actions").elements[0];
    expect(button.url).toBe("https://app.gatewerk.com/reviews/r-slack");
  });

  it("transforms payload for discord-type channel ({content, embeds})", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Discord Embed",
      webhook_url: "https://hooks.example.com/discord-embed",
      events: ["review.created"],
      type: "discord",
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-discord",
      template: "deploy-review",
      project_id: projectId,
      priority: "critical",
      created_at: "2026-05-19T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    const discordCall = mockFetch.mock.calls.find((c: any) => c[0] === "https://hooks.example.com/discord-embed");
    expect(discordCall).toBeDefined();
    const body = JSON.parse(discordCall![1].body);
    expect(typeof body.content).toBe("string");
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(body.embeds[0].url).toBe("https://app.gatewerk.com/reviews/r-discord");
    expect(body.embeds[0].color).toBe(0xEF4444); // critical
    expect(body.event).toBeUndefined();
    expect(body.blocks).toBeUndefined();
  });

  it("isolates one channel's transform failure — other channels for the same event still fire", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Bypass the Zod-enforced create path by writing the bad row directly. This
    // mirrors the realistic scenario: a future migration adds a new enum value,
    // the DB carries a row written by a newer build, and an older build reads it.
    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Future Channel",
      webhook_url: "https://hooks.example.com/future-msteams",
      events: ["review.created"],
      type: "msteams",
      is_active: true,
    });
    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Working Generic",
      webhook_url: "https://hooks.example.com/working-after-throw",
      events: ["review.created"],
      type: "generic",
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-isolated",
      template: "deploy-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-05-19T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    // The msteams channel must NOT have been fetched (transform threw before fetch).
    const msteamsCalls = mockFetch.mock.calls.filter((c: any) => c[0] === "https://hooks.example.com/future-msteams");
    expect(msteamsCalls).toHaveLength(0);
    // The generic channel after it in the loop must still have fired.
    const genericCalls = mockFetch.mock.calls.filter((c: any) => c[0] === "https://hooks.example.com/working-after-throw");
    expect(genericCalls).toHaveLength(1);
    // The failure must be logged with channel + type context.
    const transformErrCalls = consoleErrSpy.mock.calls.filter((c) => String(c[0]).includes("Notification transform failed"));
    expect(transformErrCalls.length).toBeGreaterThanOrEqual(1);

    consoleErrSpy.mockRestore();
  });

  it("logs an explicit non-ok response when the webhook returns 4xx — fetch only rejects on network failure", async () => {
    const telegramUrl = "https://api.telegram.org/bot999:NONOK/sendMessage?chat_id=-100777";
    // `mockImplementation` synthesizes a fresh Response per call so the body
    // stream isn't shared/consumed across the concurrent sibling channels left
    // in the table by earlier tests in this describe.
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          '{"ok":false,"error_code":400,"description":"Bad Request: can\'t parse entities"}',
          { status: 400, statusText: "Bad Request" },
        ),
      ),
    );
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const channelId = generateId("webhook");
    await db.insert(notificationChannels).values({
      id: channelId,
      project_id: projectId,
      name: "Telegram 400",
      webhook_url: telegramUrl,
      events: ["review.created"],
      type: "telegram",
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-tg-400",
      template: "deploy-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-05-19T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    // Find the log entry for our specific telegram URL — earlier tests in this
    // describe may have left channels in the DB that also fire on review.created.
    const telegramLog = consoleErrSpy.mock.calls.find(
      (c) => String(c[0]).includes("non-ok response") && c.includes(telegramUrl),
    );
    expect(telegramLog).toBeDefined();
    const args = telegramLog!.map(String).join(" ");
    expect(args).toContain("400");
    expect(args).toContain("Bad Request");
    expect(args).toContain("can't parse entities");

    // The same non-ok outcome is also written to the channel row — this is
    // the only place an admin can see it outside server logs.
    const channel = await getChannel(db, channelId);
    expect(channel.last_delivery_status).toBe("failed");
    expect(channel.last_delivery_at).toBeTruthy();
    expect(channel.last_error).toContain("400");

    consoleErrSpy.mockRestore();
  });

  it("clears a prior failure's last_error once a delivery to the same channel succeeds", async () => {
    const url = "https://hooks.example.com/recovers";
    const channelId = generateId("webhook");
    await db.insert(notificationChannels).values({
      id: channelId,
      project_id: projectId,
      name: "Flaky endpoint",
      webhook_url: url,
      events: ["review.created"],
      type: "generic",
      is_active: true,
    });

    const failingFetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500, statusText: "Internal Server Error" }));
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failBus = new EventBus();
    new NotificationService({ db, fetch: failingFetch, uiOrigin: "https://app.gatewerk.com" }).register(failBus);
    failBus.emit("review.created", {
      review_id: "r-recovers-1",
      template: "deploy-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-05-19T00:00:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 50));

    const afterFailure = await getChannel(db, channelId);
    expect(afterFailure.last_delivery_status).toBe("failed");
    expect(afterFailure.last_error).toContain("500");

    const okFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const okBus = new EventBus();
    new NotificationService({ db, fetch: okFetch, uiOrigin: "https://app.gatewerk.com" }).register(okBus);
    okBus.emit("review.created", {
      review_id: "r-recovers-2",
      template: "deploy-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-05-19T00:01:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 50));

    const afterSuccess = await getChannel(db, channelId);
    expect(afterSuccess.last_delivery_status).toBe("success");
    expect(afterSuccess.last_error).toBeNull();

    consoleErrSpy.mockRestore();
  });

  it("records a failed delivery when fetch itself rejects (network/DNS failure, not an HTTP response)", async () => {
    const url = "https://hooks.example.com/unreachable";
    const channelId = generateId("webhook");
    await db.insert(notificationChannels).values({
      id: channelId,
      project_id: projectId,
      name: "Unreachable endpoint",
      webhook_url: url,
      events: ["review.created"],
      type: "generic",
      is_active: true,
    });

    const rejectingFetch = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND hooks.example.com"));
    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new EventBus();
    new NotificationService({ db, fetch: rejectingFetch, uiOrigin: "https://app.gatewerk.com" }).register(bus);

    bus.emit("review.created", {
      review_id: "r-unreachable",
      template: "deploy-review",
      project_id: projectId,
      priority: "normal",
      created_at: "2026-05-19T00:00:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 50));

    const channel = await getChannel(db, channelId);
    expect(channel.last_delivery_status).toBe("failed");
    expect(channel.last_error).toContain("ENOTFOUND");

    consoleErrSpy.mockRestore();
  });

  it("transforms payload for telegram-type channel (MarkdownV2 body, no chat_id in body)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));

    await db.insert(notificationChannels).values({
      id: generateId("webhook"),
      project_id: projectId,
      name: "Telegram Bot",
      webhook_url: "https://api.telegram.org/bot123:ABC/sendMessage?chat_id=-100456",
      events: ["review.created"],
      type: "telegram",
      is_active: true,
    });

    const bus = new EventBus();
    const service = new NotificationService({ db, fetch: mockFetch, uiOrigin: "https://app.gatewerk.com" });
    service.register(bus);

    bus.emit("review.created", {
      review_id: "r-telegram",
      template: "deploy-review",
      project_id: projectId,
      priority: "high",
      created_at: "2026-05-19T00:00:00.000Z",
    });

    await new Promise((r) => setTimeout(r, 50));

    const tgCall = mockFetch.mock.calls.find((c: any) =>
      String(c[0]).startsWith("https://api.telegram.org/bot123:ABC/sendMessage"),
    );
    expect(tgCall).toBeDefined();
    // URL preserved verbatim — chat_id stays in the query string, not the body.
    expect(tgCall![0]).toBe("https://api.telegram.org/bot123:ABC/sendMessage?chat_id=-100456");
    const body = JSON.parse(tgCall![1].body);
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.disable_web_page_preview).toBe(true);
    expect(typeof body.text).toBe("string");
    expect(body.text).toContain("Review created");
    expect(body.chat_id).toBeUndefined();
    expect(body.event).toBeUndefined();
  });
});
