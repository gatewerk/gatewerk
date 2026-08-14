import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import {
  buildOptimisticLifecycle,
  type OptimisticMutationOptions,
} from "../use-optimistic-mutation";
import { ApiError } from "../http";

// Minimal shape mirrors of the typed-client schemas. If the wire shapes change,
// these get a touch-up; helper configs are the source of truth.
interface Webhook {
  id: string;
  project_id: string;
  name: string;
  webhook_url: string;
  events: string[];
  headers: Record<string, string> | null;
  is_active: boolean;
  created_at: string;
}

interface WebhookListCache {
  object: "list";
  items: Webhook[];
  has_more: boolean;
  total: number;
}

function isWebhookList(x: unknown): x is WebhookListCache {
  return !!x && typeof x === "object" && "items" in x && Array.isArray((x as { items: unknown }).items);
}

const WEBHOOKS_KEY = ["settings", "webhooks"] as const;

const existing: Webhook = {
  id: "wh_1",
  project_id: "proj_1",
  name: "Slack",
  webhook_url: "https://hooks.slack.com/services/xxx",
  events: ["review.decided"],
  headers: null,
  is_active: true,
  created_at: "2026-04-10T00:00:00Z",
};

const secondExisting: Webhook = {
  id: "wh_2",
  project_id: "proj_1",
  name: "PagerDuty",
  webhook_url: "https://events.pagerduty.com/x",
  events: ["review.urgent"],
  headers: null,
  is_active: true,
  created_at: "2026-04-11T00:00:00Z",
};

function seed(qc: QueryClient, items: Webhook[]): void {
  qc.setQueryData<WebhookListCache>([...WEBHOOKS_KEY], {
    object: "list",
    items,
    has_more: false,
    total: items.length,
  });
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// The three options consts mirror the production values in Settings.tsx.
// Kept local so the tests verify the intended helper config even if the Settings
// module reorganizes its exports.

const createWebhookOptions: OptimisticMutationOptions<
  { name: string; webhook_url: string; events: string[]; headers?: Record<string, string> },
  Webhook
> = {
  keys: () => [WEBHOOKS_KEY],
  onServerResponse: (prev, response) => {
    if (!isWebhookList(prev)) return undefined;
    return { ...prev, items: [response, ...prev.items], total: prev.total + 1 };
  },
};

type UpdateInput = {
  id: string;
  name?: string;
  webhook_url?: string;
  events?: string[];
  headers?: Record<string, string> | null;
  is_active?: boolean;
};

const updateWebhookOptions: OptimisticMutationOptions<UpdateInput, Webhook> = {
  keys: () => [WEBHOOKS_KEY],
  onOptimistic: (prev, input) => {
    if (!isWebhookList(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.map((w) => (w.id === input.id ? { ...w, ...input } : w)),
    };
  },
  onServerResponse: (prev, response, input) => {
    if (!isWebhookList(prev)) return undefined;
    return { ...prev, items: prev.items.map((w) => (w.id === input.id ? response : w)) };
  },
};

const deleteWebhookOptions: OptimisticMutationOptions<{ id: string }, void> = {
  keys: () => [WEBHOOKS_KEY],
  onOptimistic: (prev, input) => {
    if (!isWebhookList(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.filter((w) => w.id !== input.id),
      total: Math.max(0, prev.total - 1),
    };
  },
};

// ── createWebhook ────────────────────────────────────────────────────────────

describe("createWebhook wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepends the server response + bumps total on success", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, createWebhookOptions);

    await lifecycle.onMutate({
      name: "PagerDuty",
      webhook_url: "https://events.pagerduty.com/x",
      events: ["review.urgent"],
    });
    lifecycle.onSuccess(secondExisting, {
      name: "PagerDuty",
      webhook_url: "https://events.pagerduty.com/x",
      events: ["review.urgent"],
    });

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items).toEqual([secondExisting, existing]);
    expect(cache?.total).toBe(2);
  });

  it("rollback is a no-op (no onOptimistic patch was applied)", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, createWebhookOptions);

    const snapshots = await lifecycle.onMutate({
      name: "Bad",
      webhook_url: "https://x",
      events: ["x"],
    });
    lifecycle.onError(new ApiError(422, "bad", "validation_failed"), {
      name: "Bad",
      webhook_url: "https://x",
      events: ["x"],
    }, snapshots);

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items).toEqual([existing]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

// ── updateWebhook (form save + toggle share this config) ─────────────────────

describe("updateWebhook wiring (form save path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically merges input onto the cached row", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, updateWebhookOptions);

    await lifecycle.onMutate({
      id: existing.id,
      name: "Slack (renamed)",
      events: ["review.decided", "review.expired"],
    });

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    const patched = cache?.items.find((w) => w.id === existing.id);
    expect(patched?.name).toBe("Slack (renamed)");
    expect(patched?.events).toEqual(["review.decided", "review.expired"]);
    expect(patched?.is_active).toBe(true); // untouched
    // Non-target row untouched
    expect(cache?.items.find((w) => w.id === secondExisting.id)).toEqual(secondExisting);
  });

  it("server response replaces the target row with canonical truth", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateWebhookOptions);

    const serverTruth: Webhook = {
      ...existing,
      name: "Slack (renamed)",
      events: ["review.decided", "review.expired"],
    };

    await lifecycle.onMutate({ id: existing.id, name: "Slack (renamed)", events: ["review.decided", "review.expired"] });
    lifecycle.onSuccess(serverTruth, { id: existing.id });

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items.find((w) => w.id === existing.id)).toEqual(serverTruth);
  });

  it("rollback restores the pre-optimistic snapshot on error", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateWebhookOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id, name: "Bad" });
    lifecycle.onError(new ApiError(500, "boom", "internal_error", "req-42"), { id: existing.id, name: "Bad" }, snapshots);

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items).toEqual([existing]); // restored exactly
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-42");
  });
});

describe("updateWebhook wiring (toggle path — same options)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically flips is_active on the cached row", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateWebhookOptions);

    await lifecycle.onMutate({ id: existing.id, is_active: false });

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items[0].is_active).toBe(false);
    // Other fields preserved
    expect(cache?.items[0].name).toBe(existing.name);
    expect(cache?.items[0].events).toEqual(existing.events);
  });

  it("rollback restores is_active when server rejects", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateWebhookOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id, is_active: false });
    lifecycle.onError(new ApiError(403, "forbidden"), { id: existing.id, is_active: false }, snapshots);

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items[0].is_active).toBe(true); // restored
    // 403 surfaces as warning toast per mapError
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// ── deleteWebhook ────────────────────────────────────────────────────────────

describe("deleteWebhook wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically removes the target + decrements total", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, deleteWebhookOptions);

    await lifecycle.onMutate({ id: existing.id });

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items).toEqual([secondExisting]);
    expect(cache?.total).toBe(1);
  });

  it("rollback restores the removed row + total on error", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, deleteWebhookOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id });
    lifecycle.onError(new ApiError(404, "not found"), { id: existing.id }, snapshots);

    const cache = qc.getQueryData<WebhookListCache>([...WEBHOOKS_KEY]);
    expect(cache?.items).toEqual([existing, secondExisting]);
    expect(cache?.total).toBe(2);
    // 404 maps to warning
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("empty-cache defensive: onOptimistic leaves undefined cache untouched", async () => {
    const qc = makeQueryClient();
    const lifecycle = buildOptimisticLifecycle(qc, deleteWebhookOptions);

    await lifecycle.onMutate({ id: existing.id });

    expect(qc.getQueryData([...WEBHOOKS_KEY])).toBeUndefined();
  });
});
