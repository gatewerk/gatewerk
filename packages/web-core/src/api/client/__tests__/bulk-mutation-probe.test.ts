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

import { buildOptimisticLifecycle } from "../use-optimistic-mutation";
import { ApiError } from "../http";

// Probe tests for PR 3 slice 3b-f. Goal: before building bulk decide / bulk archive,
// empirically confirm what happens when N `useOptimisticMutation` instances fire
// concurrently via Promise.all.
//
// Two shapes exercised:
//   (A) "Decide" pattern — each mutation's `keys` returns a unique per-review cache key
//       `[["review", id]]`. Snapshots are disjoint, so rollback on one never touches another.
//   (B) "Archive" pattern — every mutation's `keys` returns the SAME list-cache key
//       `[["reviews", "decided", offset, showArchived]]`. Snapshots race: m2's
//       snapshot captures m1's optimistic patch; m3's rollback clobbers m4/m5's patches.
//
// The probe drives a real `QueryClient` through the lifecycle callbacks with async
// mutation fns that interleave via `await Promise.resolve()` microtasks — mirrors the
// real `Promise.all([mutateAsync, mutateAsync, …])` call shape used by React Query.

interface Review {
  id: string;
  status: string;
  version: number;
  decided_at: string | null;
}

type DecideInput = { id: string; decision: "approved" | "rejected" };
type ArchiveInput = { id: string };

const baseReview = (id: string, overrides: Partial<Review> = {}): Review => ({
  id,
  status: "pending",
  version: 1,
  decided_at: null,
  ...overrides,
});

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// Thin React-Query-shaped driver. Mirrors how `useMutation` calls the lifecycle:
// onMutate → mutationFn → (success: onSuccess | error: onError). Returns a Promise that
// resolves with `{ ok, value?, error? }` so Promise.allSettled-style inspection works.
async function drive<I, O>(
  lifecycle: ReturnType<typeof buildOptimisticLifecycle<I, O>>,
  input: I,
  mutationFn: (input: I) => Promise<O>,
): Promise<{ ok: true; value: O } | { ok: false; error: unknown }> {
  const snapshots = await lifecycle.onMutate(input);
  try {
    const value = await mutationFn(input);
    lifecycle.onSuccess(value, input);
    return { ok: true, value };
  } catch (error) {
    lifecycle.onError(error, input, snapshots);
    return { ok: false, error };
  }
}

describe("probe — concurrent mutations on DISJOINT keys (decide pattern)", () => {
  beforeEach(() => vi.clearAllMocks());

  function decideLifecycle(qc: QueryClient) {
    return buildOptimisticLifecycle<DecideInput, Review>(qc, {
      keys: ({ id }) => [["review", id]],
      onOptimistic: (prev, { decision }) => {
        if (!prev) return undefined;
        return { ...(prev as Review), status: decision, decided_at: "2026-04-18T00:00:00Z" };
      },
      onServerResponse: (_prev, response) => response,
      invalidateOnSuccess: () => [["reviews"]],
    });
  }

  it("five concurrent decides on different IDs: all optimistic patches land, no interference", async () => {
    const qc = makeQueryClient();
    for (let i = 1; i <= 5; i++) qc.setQueryData(["review", `rev_${i}`], baseReview(`rev_${i}`));
    const lifecycle = decideLifecycle(qc);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        drive<DecideInput, Review>(
          lifecycle,
          { id: `rev_${i}`, decision: i % 2 === 0 ? "rejected" : "approved" },
          async (input) => {
            await Promise.resolve(); // yield once to interleave with peers
            return baseReview(input.id, {
              status: input.decision,
              version: 2,
              decided_at: "2026-04-18T01:00:00Z",
            });
          },
        ),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    for (let i = 1; i <= 5; i++) {
      const cached = qc.getQueryData<Review>(["review", `rev_${i}`]);
      expect(cached?.status).toBe(i % 2 === 0 ? "rejected" : "approved");
      expect(cached?.version).toBe(2);
    }
  });

  it("mixed success/failure on disjoint keys: one error rolls back only its own snapshot", async () => {
    const qc = makeQueryClient();
    for (let i = 1; i <= 3; i++) qc.setQueryData(["review", `rev_${i}`], baseReview(`rev_${i}`));
    const lifecycle = decideLifecycle(qc);

    const results = await Promise.all([
      drive<DecideInput, Review>(lifecycle, { id: "rev_1", decision: "approved" }, async (input) => {
        await Promise.resolve();
        return baseReview(input.id, { status: "approved", version: 2, decided_at: "x" });
      }),
      drive<DecideInput, Review>(lifecycle, { id: "rev_2", decision: "approved" }, async () => {
        await Promise.resolve();
        throw new ApiError(403, "no access", "forbidden");
      }),
      drive<DecideInput, Review>(lifecycle, { id: "rev_3", decision: "rejected" }, async (input) => {
        await Promise.resolve();
        return baseReview(input.id, { status: "rejected", version: 2, decided_at: "y" });
      }),
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);

    // Disjoint keys → error on rev_2 does not touch rev_1 or rev_3.
    expect(qc.getQueryData<Review>(["review", "rev_1"])?.status).toBe("approved");
    expect(qc.getQueryData<Review>(["review", "rev_2"])?.status).toBe("pending"); // rolled back
    expect(qc.getQueryData<Review>(["review", "rev_3"])?.status).toBe("rejected");
  });
});

describe("probe — concurrent mutations on SHARED key (archive pattern)", () => {
  beforeEach(() => vi.clearAllMocks());

  const LIST_KEY = ["reviews", "decided", 0, false] as const;
  type ListCache = { items: Review[]; total: number; has_more: boolean };

  function archiveLifecycle(qc: QueryClient) {
    return buildOptimisticLifecycle<ArchiveInput, Review>(qc, {
      keys: () => [[...LIST_KEY]],
      onOptimistic: (prev, input) => {
        if (!prev || typeof prev !== "object" || !("items" in prev)) return undefined;
        const cache = prev as ListCache;
        if (!Array.isArray(cache.items)) return undefined;
        return {
          ...cache,
          items: cache.items.filter((r) => r.id !== input.id),
          total: Math.max(0, cache.total - 1),
        };
      },
      invalidateOnSuccess: () => [["reviews"]],
    });
  }

  function seed(qc: QueryClient, ids: string[]) {
    qc.setQueryData([...LIST_KEY], {
      items: ids.map((id) => baseReview(id, { status: "decided" })),
      total: ids.length,
      has_more: false,
    });
  }

  it("all-success shared-key: optimistic patches compose correctly (each filter stacks)", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c", "d", "e"]);
    const lifecycle = archiveLifecycle(qc);

    const results = await Promise.all(
      ["a", "b", "c"].map((id) =>
        drive<ArchiveInput, Review>(lifecycle, { id }, async (input) => {
          await Promise.resolve();
          return baseReview(input.id, { status: "archived" });
        }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id)).toEqual(["d", "e"]);
    expect(cache?.total).toBe(2);
  });

  it("INTERFERENCE DOCUMENTED: one error mid-batch rolls back to a STALE snapshot, clobbering peers' patches", async () => {
    // This test captures the exact failure mode. It is the probe's core signal.
    // After this test passes we know the risk is real and must design around it.
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c", "d", "e"]);
    const lifecycle = archiveLifecycle(qc);

    // Fire 5 archives concurrently. "c" fails. "a", "b", "d", "e" succeed.
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) =>
        drive<ArchiveInput, Review>(lifecycle, { id }, async (input) => {
          await Promise.resolve();
          if (input.id === "c") {
            throw new ApiError(409, "already decided", "review_already_decided");
          }
          return baseReview(input.id, { status: "archived" });
        }),
      ),
    );

    expect(results.map((r) => r.ok)).toEqual([true, true, false, true, true]);

    // The KEY FINDING: because rollback order is determined by microtask resolution order,
    // post-batch cache state is unpredictable. It is NOT "b, d, e left" (the correct state).
    // In practice the rollback from "c" sets cache to whatever snapshot "c" captured, which
    // depends on how many peers resolved onMutate before it. The only reliable guarantee is
    // that `invalidateOnSuccess` from successful peers queues a refetch that will eventually
    // converge — but between optimistic apply and refetch landing, UI shows a stale view.
    //
    // Assertion: cache is NOT in the expected steady state of `["c"]` remaining.
    // Either it contains "c" (rollback restored it) AND some peers that should be archived,
    // OR it matches the ideal `["c"]` (if rollback happened to fire last and restore the
    // fully-filtered snapshot that "c" itself captured).
    //
    // The test passes either way — we're not asserting a specific broken state, we're
    // asserting "don't trust per-mutation optimistic + rollback on a shared cache key."
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache).toBeTruthy();

    // The rollback for "c" put cache back to whatever "c" snapshotted, which due to
    // sequential-microtask execution of `onMutate` is the state AFTER a/b filtered out
    // but BEFORE d/e. So cache ends with [c, d, e] remaining — d/e's patches lost.
    const finalIds = cache!.items.map((r) => r.id).sort();
    expect(finalIds).toContain("c"); // c is back
    expect(finalIds.length).toBeGreaterThan(1); // d and/or e also present (patches lost)
  });

  it("SECOND FINDING: all-failure shared-key does NOT restore baseline — snapshots chain in the wrong direction", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c"]);
    const lifecycle = archiveLifecycle(qc);

    const results = await Promise.all(
      ["a", "b", "c"].map((id) =>
        drive<ArchiveInput, Review>(lifecycle, { id }, async () => {
          await Promise.resolve();
          throw new ApiError(403, "no", "forbidden");
        }),
      ),
    );

    expect(results.every((r) => !r.ok)).toBe(true);

    // Expected: all-fail → cache restored to baseline [a,b,c]. Reality: cache ends at [c].
    //
    // Why: onMutate runs sequentially across peers (JS is single-threaded + the `await
    // cancelQueries` microtask yield is shallow). Each peer's snapshot captures the cache
    // AFTER prior peers have already written their optimistic patch:
    //   m1 snapshot = [a,b,c]  (baseline);   optimistic write → [b,c]
    //   m2 snapshot = [b,c]    (post-m1);    optimistic write → [c]
    //   m3 snapshot = [c]      (post-m1+m2); optimistic write → []
    // Mutation fns resolve in order. onError restores snapshot last-write-wins:
    //   m1 rollback → cache = [a,b,c]
    //   m2 rollback → cache = [b,c]
    //   m3 rollback → cache = [c]   ← final state
    //
    // The per-mutation rollback model is fundamentally unsafe when keys collide.
    // This test locks the finding so a future session can't "fix" it by tweaking
    // rollback order — the design itself is the issue.
    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id)).toEqual(["c"]);
  });
});

describe("probe — caller-side aggregate snapshot (recommended pattern for shared-key bulk)", () => {
  beforeEach(() => vi.clearAllMocks());

  const LIST_KEY = ["reviews", "decided", 0, false] as const;
  type ListCache = { items: Review[]; total: number; has_more: boolean };

  function seed(qc: QueryClient, ids: string[]) {
    qc.setQueryData([...LIST_KEY], {
      items: ids.map((id) => baseReview(id, { status: "decided" })),
      total: ids.length,
      has_more: false,
    });
  }

  // The pattern: caller snapshots once, applies one aggregate optimistic patch,
  // fires N plain mutations (no per-mutation optimistic), and on ANY rejection
  // rolls back the cache to the single pre-batch snapshot + refetches.
  async function bulkArchive(
    qc: QueryClient,
    ids: string[],
    mutationFn: (id: string) => Promise<Review>,
  ): Promise<{ succeeded: string[]; failed: { id: string; error: unknown }[] }> {
    await qc.cancelQueries({ queryKey: [...LIST_KEY] });
    const snapshot = qc.getQueryData<ListCache>([...LIST_KEY]);
    if (snapshot && Array.isArray(snapshot.items)) {
      qc.setQueryData([...LIST_KEY], {
        ...snapshot,
        items: snapshot.items.filter((r) => !ids.includes(r.id)),
        total: Math.max(0, snapshot.total - ids.length),
      });
    }

    const results = await Promise.allSettled(ids.map((id) => mutationFn(id)));
    const succeeded: string[] = [];
    const failed: { id: string; error: unknown }[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(ids[i]);
      else failed.push({ id: ids[i], error: r.reason });
    });

    // On ANY failure: we can either fully rollback to snapshot (simple, loses succeeded
    // patches until refetch) or do a targeted re-add of failed IDs. Simpler wins.
    if (failed.length > 0 && snapshot) {
      const failedIds = new Set(failed.map((f) => f.id));
      const restoredItems = [...(qc.getQueryData<ListCache>([...LIST_KEY])?.items ?? [])];
      for (const failedId of failedIds) {
        const original = snapshot.items.find((r) => r.id === failedId);
        if (original && !restoredItems.some((r) => r.id === failedId)) {
          restoredItems.push(original);
        }
      }
      qc.setQueryData([...LIST_KEY], {
        ...(qc.getQueryData<ListCache>([...LIST_KEY]) ?? snapshot),
        items: restoredItems,
        total: snapshot.total - succeeded.length,
      });
    }

    qc.invalidateQueries({ queryKey: ["reviews"] });
    return { succeeded, failed };
  }

  it("bulk archive 5 with one failure: cache reflects reality (succeeded removed, failed restored)", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c", "d", "e"]);

    const { succeeded, failed } = await bulkArchive(qc, ["a", "b", "c", "d", "e"], async (id) => {
      await Promise.resolve();
      if (id === "c") {
        throw new ApiError(409, "already decided", "review_already_decided");
      }
      return baseReview(id, { status: "archived" });
    });

    expect(succeeded.sort()).toEqual(["a", "b", "d", "e"]);
    expect(failed.map((f) => f.id)).toEqual(["c"]);

    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    // Succeeded ids removed; failed id ("c") restored.
    expect(cache?.items.map((r) => r.id).sort()).toEqual(["c"]);
    expect(cache?.total).toBe(1);
  });

  it("bulk archive all-success: cache has none of the archived ids", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c"]);

    const { succeeded, failed } = await bulkArchive(qc, ["a", "b", "c"], async (id) => {
      await Promise.resolve();
      return baseReview(id, { status: "archived" });
    });

    expect(succeeded.sort()).toEqual(["a", "b", "c"]);
    expect(failed).toEqual([]);

    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items).toEqual([]);
    expect(cache?.total).toBe(0);
  });

  it("bulk archive all-fail: snapshot fully restored, total unchanged", async () => {
    const qc = makeQueryClient();
    seed(qc, ["a", "b", "c"]);

    const { succeeded, failed } = await bulkArchive(qc, ["a", "b", "c"], async () => {
      await Promise.resolve();
      throw new ApiError(403, "no", "forbidden");
    });

    expect(succeeded).toEqual([]);
    expect(failed.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);

    const cache = qc.getQueryData<ListCache>([...LIST_KEY]);
    expect(cache?.items.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(cache?.total).toBe(3);
  });
});
