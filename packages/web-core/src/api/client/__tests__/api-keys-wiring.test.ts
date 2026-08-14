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

// Minimal shape mirrors. The real ApiKey type includes many nullable fields
// (callback_url, default_reviewer, rate_limit_per_hour, etc) that don't change
// the helper's cache semantics; the tests use a reduced shape.
interface ApiKey {
  id: string;
  name: string | null;
  description: string | null;
  key_prefix: string;
  scopes: string[] | null;
  template_ids: string[] | null;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  expires_at: string | null;
  ip_allowlist: string[] | null;
}

interface ApiKeyWithSecret extends ApiKey {
  raw_key: string;
}

interface ApiKeyListCache {
  object: "list";
  items: ApiKey[];
  has_more: boolean;
  total: number;
}

function isApiKeyList(x: unknown): x is ApiKeyListCache {
  return !!x && typeof x === "object" && "items" in x && Array.isArray((x as { items: unknown }).items);
}

const API_KEYS_KEY = ["settings", "api-keys"] as const;

const existing: ApiKey = {
  id: "ak_1",
  name: "Prod agent",
  description: null,
  key_prefix: "gwk_abc",
  scopes: ["reviews:create"],
  template_ids: null,
  is_active: true,
  last_used_at: null,
  created_at: "2026-04-10T00:00:00Z",
  expires_at: null,
  ip_allowlist: null,
};

const secondExisting: ApiKey = {
  ...existing,
  id: "ak_2",
  name: "Staging agent",
  key_prefix: "gwk_xyz",
};

function seed(qc: QueryClient, items: ApiKey[]): void {
  qc.setQueryData<ApiKeyListCache>([...API_KEYS_KEY], {
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

function stripRawKey(withSecret: ApiKeyWithSecret): ApiKey {
  const { raw_key: _ignored, ...rest } = withSecret;
  void _ignored;
  return rest;
}

// ── Options consts (mirror Settings.tsx) ────────────────────────────────────

const createApiKeyOptions: OptimisticMutationOptions<{ name: string; scopes: string[] }, ApiKeyWithSecret> = {
  keys: () => [API_KEYS_KEY],
  onServerResponse: (prev, response) => {
    if (!isApiKeyList(prev)) return undefined;
    return { ...prev, items: [stripRawKey(response), ...prev.items], total: prev.total + 1 };
  },
};

type UpdateInput = {
  id: string;
  name?: string;
  description?: string | null;
  scopes?: string[];
  is_active?: boolean;
};

const updateApiKeyOptions: OptimisticMutationOptions<UpdateInput, ApiKey> = {
  keys: () => [API_KEYS_KEY],
  onOptimistic: (prev, input) => {
    if (!isApiKeyList(prev)) return undefined;
    return { ...prev, items: prev.items.map((k) => (k.id === input.id ? { ...k, ...input } : k)) };
  },
  onServerResponse: (prev, response, input) => {
    if (!isApiKeyList(prev)) return undefined;
    return { ...prev, items: prev.items.map((k) => (k.id === input.id ? response : k)) };
  },
};

const deleteApiKeyOptions: OptimisticMutationOptions<{ id: string }, void> = {
  keys: () => [API_KEYS_KEY],
  onOptimistic: (prev, input) => {
    if (!isApiKeyList(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.filter((k) => k.id !== input.id),
      total: Math.max(0, prev.total - 1),
    };
  },
};

const rotateApiKeyOptions: OptimisticMutationOptions<{ id: string }, ApiKeyWithSecret> = {
  keys: () => [API_KEYS_KEY],
  onServerResponse: (prev, response, input) => {
    if (!isApiKeyList(prev)) return undefined;
    return { ...prev, items: prev.items.map((k) => (k.id === input.id ? stripRawKey(response) : k)) };
  },
};

const sendTestRequestOptions: OptimisticMutationOptions<{ id: string }, { test: true }> = {
  keys: () => [],
};

// ── createApiKey ─────────────────────────────────────────────────────────────

describe("createApiKey wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips raw_key from the server response before merging into the list cache", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, createApiKeyOptions);

    const serverResult: ApiKeyWithSecret = {
      ...secondExisting,
      raw_key: "gwk_xyz_SECRET_ONLY_SHOWN_ONCE",
    };

    await lifecycle.onMutate({ name: "Staging agent", scopes: ["reviews:create"] });
    lifecycle.onSuccess(serverResult, { name: "Staging agent", scopes: ["reviews:create"] });

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items[0]).toEqual(secondExisting); // no raw_key
    expect(cache?.items[0]).not.toHaveProperty("raw_key");
    expect(cache?.total).toBe(2);
  });

  it("rollback is a no-op (no onOptimistic patch)", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, createApiKeyOptions);

    const snapshots = await lifecycle.onMutate({ name: "Bad", scopes: [] });
    lifecycle.onError(new ApiError(422, "scopes required", "validation_failed"), { name: "Bad", scopes: [] }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([existing]);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

// ── updateApiKey (form save + toggle share options) ─────────────────────────

describe("updateApiKey wiring (form save)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically merges input onto the cached row", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, updateApiKeyOptions);

    await lifecycle.onMutate({ id: existing.id, name: "Prod agent v2", description: "new desc" });

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    const patched = cache?.items.find((k) => k.id === existing.id);
    expect(patched?.name).toBe("Prod agent v2");
    expect(patched?.description).toBe("new desc");
    expect(patched?.is_active).toBe(true); // untouched
    // Non-target row untouched
    expect(cache?.items.find((k) => k.id === secondExisting.id)).toEqual(secondExisting);
  });

  it("rollback restores snapshot on 500", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateApiKeyOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id, name: "Bad" });
    lifecycle.onError(new ApiError(500, "boom", "internal_error", "req-99"), { id: existing.id, name: "Bad" }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([existing]);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-99");
  });
});

describe("updateApiKey wiring (toggle path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically flips is_active", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateApiKeyOptions);

    await lifecycle.onMutate({ id: existing.id, is_active: false });

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items[0].is_active).toBe(false);
    expect(cache?.items[0].name).toBe(existing.name);
  });

  it("rollback restores is_active when server rejects", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, updateApiKeyOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id, is_active: false });
    lifecycle.onError(new ApiError(403, "forbidden"), { id: existing.id, is_active: false }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items[0].is_active).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// ── deleteApiKey ─────────────────────────────────────────────────────────────

describe("deleteApiKey wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically removes + decrements total", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, deleteApiKeyOptions);

    await lifecycle.onMutate({ id: existing.id });

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([secondExisting]);
    expect(cache?.total).toBe(1);
  });

  it("rollback restores on error", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing, secondExisting]);
    const lifecycle = buildOptimisticLifecycle(qc, deleteApiKeyOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id });
    lifecycle.onError(new ApiError(404, "not found"), { id: existing.id }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([existing, secondExisting]);
    expect(cache?.total).toBe(2);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// ── rotateApiKey ─────────────────────────────────────────────────────────────

describe("rotateApiKey wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates cached metadata with stripped server response (no raw_key leak)", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, rotateApiKeyOptions);

    const rotated: ApiKeyWithSecret = {
      ...existing,
      key_prefix: "gwk_NEW",
      raw_key: "gwk_NEW_SECRET_ONLY_SHOWN_ONCE",
    };

    await lifecycle.onMutate({ id: existing.id });
    lifecycle.onSuccess(rotated, { id: existing.id });

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    const patched = cache?.items[0];
    expect(patched?.key_prefix).toBe("gwk_NEW");
    expect(patched).not.toHaveProperty("raw_key");
  });

  it("raw_key is not leaked into the cache on error snapshot either", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, rotateApiKeyOptions);

    // Snapshot captures current cache (no raw_key). Rollback restores the same.
    const snapshots = await lifecycle.onMutate({ id: existing.id });
    lifecycle.onError(new ApiError(500, "boom"), { id: existing.id }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items[0]).toEqual(existing);
    expect(cache?.items[0]).not.toHaveProperty("raw_key");
  });
});

// ── sendTestRequest ──────────────────────────────────────────────────────────

describe("sendTestRequest wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has no cache effect on success", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, sendTestRequestOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id });
    expect(snapshots).toEqual([]);

    lifecycle.onSuccess({ test: true }, { id: existing.id });

    // Cache untouched — keys: [] means nothing in the QueryClient was touched.
    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([existing]);
  });

  it("surfaces errors via mapError (no rollback state to restore)", async () => {
    const qc = makeQueryClient();
    seed(qc, [existing]);
    const lifecycle = buildOptimisticLifecycle(qc, sendTestRequestOptions);

    const snapshots = await lifecycle.onMutate({ id: existing.id });
    lifecycle.onError(new ApiError(500, "upstream down"), { id: existing.id }, snapshots);

    const cache = qc.getQueryData<ApiKeyListCache>([...API_KEYS_KEY]);
    expect(cache?.items).toEqual([existing]); // untouched
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
