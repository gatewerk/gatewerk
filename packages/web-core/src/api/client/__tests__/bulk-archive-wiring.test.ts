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

import { buildOptimisticLifecycle, type OptimisticMutationOptions } from "../use-optimistic-mutation";
import { ApiError } from "../http";

// Wiring tests for the production `bulkArchiveOptions` defined in History.tsx.
// The options const itself is scoped to the component (closes over `offset` /
// `showArchived`), so the tests recreate its shape exactly here — if the in-component
// options drift, these tests stay locked to the intended contract.

interface Review {
  id: string;
  status: string;
}
type ListCache = { items: Review[]; total: number; has_more: boolean };

const LIST_KEY = ["reviews", "decided", 0, false] as const;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function seed(qc: QueryClient, ids: string[]) {
  qc.setQueryData([...LIST_KEY], {
    items: ids.map((id) => ({ id, status: "decided" })),
    total: ids.length,
    has_more: false,
  } satisfies ListCache);
}

function bulkArchiveOptions(): OptimisticMutationOptions<{ ids: string[] }, { ok: boolean; count: number }> {
  return {
    keys: () => [[...LIST_KEY]],
    onOptimistic: (prev, input) => {
      if (!prev || typeof prev !== "object" || !("items" in prev)) return undefined;
      const cache = prev as ListCache;
      if (!Array.isArray(cache.items)) return undefined;
      const idSet = new Set(input.ids);
      return {
        ...cache,
        items: cache.items.filter((r) => !idSet.has(r.id)),
        total: Math.max(0, cache.total - input.ids.length),
      };
    },
    invalidateOnSuccess: () => [["reviews"]],
  };
}

describe("bulk archive wiring — single atomic mutation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path: single mutation filters all input ids from the list cache", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c", "d", "e"]);
    const lifecycle = buildOptimisticLifecycle(qc, bulkArchiveOptions());

    const snapshots = await lifecycle.onMutate({ ids: ["a", "b", "c"] });

    expect(snapshots).toHaveLength(1);
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id)).toEqual(["d", "e"]);
    expect(cache?.total).toBe(2);
  });

  it("happy path: server response is acknowledged via invalidate, optimistic state stays", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c"]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = buildOptimisticLifecycle(qc, bulkArchiveOptions());

    await lifecycle.onMutate({ ids: ["a", "b"] });
    lifecycle.onSuccess({ ok: true, count: 2 }, { ids: ["a", "b"] });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews"] });
    // Optimistic state stays (no onServerResponse); invalidate refetches truth from server.
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id)).toEqual(["c"]);
  });

  it("rollback: single snapshot restore on error", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c"]);
    const lifecycle = buildOptimisticLifecycle(qc, bulkArchiveOptions());

    const snapshots = await lifecycle.onMutate({ ids: ["a", "b"] });
    // Mid-flight cache is filtered:
    expect(qc.getQueryData<ListCache>([...LIST_KEY])?.items.map((r) => r.id)).toEqual(["c"]);

    lifecycle.onError(new ApiError(403, "no access", "forbidden"), { ids: ["a", "b"] }, snapshots);

    // Rolled back to baseline in one write.
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(cache?.total).toBe(3);
  });

  it("defensive: undefined cache returns undefined from onOptimistic, snapshot still recorded", async () => {
    const qc = makeQueryClient();
    // No cache seeded.
    const lifecycle = buildOptimisticLifecycle(qc, bulkArchiveOptions());

    const snapshots = await lifecycle.onMutate({ ids: ["a", "b"] });

    expect(snapshots).toEqual([{ key: [...LIST_KEY], prev: undefined }]);
    expect(qc.getQueryData([...LIST_KEY])).toBeUndefined();
  });

  it("partial server count: optimistic over-removes if server archived fewer, invalidate corrects", async () => {
    // Scenario: client sends 5 ids, server only archives 3 (2 were already archived server-side).
    // Optimistic removed all 5; invalidate refetches the true state. Documents the contract.
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c", "d", "e", "f"]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = buildOptimisticLifecycle(qc, bulkArchiveOptions());

    await lifecycle.onMutate({ ids: ["a", "b", "c", "d", "e"] });
    expect(qc.getQueryData<ListCache>([...LIST_KEY])?.items.map((r) => r.id)).toEqual(["f"]);

    lifecycle.onSuccess({ ok: true, count: 3 }, { ids: ["a", "b", "c", "d", "e"] });

    // Cache still shows ["f"] optimistically; invalidate will refetch the real state.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews"] });
  });
});
