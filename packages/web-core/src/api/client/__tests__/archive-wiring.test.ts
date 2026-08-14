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

// Minimal Review shape — the helper's cache semantics only exercise id +
// membership in the items array. The real Review type has many fields; none
// are touched by the archive cache patch.
interface Review {
  id: string;
  status: string;
}

interface ReviewListCache {
  object?: "list";
  items: Review[];
  has_more: boolean;
  total: number;
}

// History.tsx builds its own cache key from runtime state: ["reviews",
// "decided", offset, showArchived]. Tests mirror that shape via a concrete
// offset + showArchived pair (page 1, archive-hidden is the typical case).
const offset = 0;
const showArchived = false;
const DECIDED_KEY = ["reviews", "decided", offset, showArchived] as const;
const REVIEWS_PREFIX = ["reviews"] as const;

function isDecidedListShape(prev: unknown): prev is ReviewListCache {
  return !!prev && typeof prev === "object" && "items" in prev && Array.isArray((prev as { items: unknown }).items);
}

const archiveOptions: OptimisticMutationOptions<{ id: string }, Review> = {
  keys: () => [DECIDED_KEY],
  onOptimistic: (prev, input) => {
    if (!isDecidedListShape(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.filter((r) => r.id !== input.id),
      total: Math.max(0, prev.total - 1),
    };
  },
  invalidateOnSuccess: () => [REVIEWS_PREFIX],
};

const unarchiveOptions: OptimisticMutationOptions<{ id: string }, Review> = {
  keys: () => [],
  invalidateOnSuccess: () => [REVIEWS_PREFIX],
};

const reviewOne: Review = { id: "rv_1", status: "decided" };
const reviewTwo: Review = { id: "rv_2", status: "decided" };

function seed(qc: QueryClient, items: Review[]): void {
  qc.setQueryData<ReviewListCache>([...DECIDED_KEY], {
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

// ── archive (immediate-commit) ───────────────────────────────────────────────

describe("archiveReview wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically removes the review from the visible page cache + decrements total", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewOne, reviewTwo]);
    const lifecycle = buildOptimisticLifecycle(qc, archiveOptions);

    await lifecycle.onMutate({ id: reviewOne.id });

    const cache = qc.getQueryData<ReviewListCache>([...DECIDED_KEY]);
    expect(cache?.items).toEqual([reviewTwo]);
    expect(cache?.total).toBe(1);
  });

  it("rollback restores the review on 500 + toast surfaces request_id", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewOne, reviewTwo]);
    const lifecycle = buildOptimisticLifecycle(qc, archiveOptions);

    const snapshots = await lifecycle.onMutate({ id: reviewOne.id });
    lifecycle.onError(
      new ApiError(500, "boom", "internal_error", "req-archive-7"),
      { id: reviewOne.id },
      snapshots,
    );

    const cache = qc.getQueryData<ReviewListCache>([...DECIDED_KEY]);
    expect(cache?.items).toEqual([reviewOne, reviewTwo]);
    expect(cache?.total).toBe(2);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-archive-7");
  });

  it("invalidateOnSuccess fires against ['reviews'] prefix so other list views refresh", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewOne]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = buildOptimisticLifecycle(qc, archiveOptions);

    await lifecycle.onMutate({ id: reviewOne.id });
    lifecycle.onSuccess({ ...reviewOne, status: "archived" }, { id: reviewOne.id });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REVIEWS_PREFIX });
  });

  it("defensively bails when the visible page cache is the wrong shape", async () => {
    const qc = makeQueryClient();
    // Simulate a cache that doesn't match the review-list shape (e.g. stale
    // undefined or a non-list payload from a broken fetch).
    qc.setQueryData([...DECIDED_KEY], null);
    const lifecycle = buildOptimisticLifecycle(qc, archiveOptions);

    await lifecycle.onMutate({ id: reviewOne.id });

    // Cache untouched — onOptimistic returned undefined.
    expect(qc.getQueryData([...DECIDED_KEY])).toBeNull();
  });
});

// ── unarchive (Undo path + direct restore) ───────────────────────────────────

describe("unarchiveReview wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has no precise cache effect — relies on invalidate to pick up the restored status", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewTwo]); // reviewOne was archived, now being restored
    const lifecycle = buildOptimisticLifecycle(qc, unarchiveOptions);

    const snapshots = await lifecycle.onMutate({ id: reviewOne.id });
    expect(snapshots).toEqual([]);

    lifecycle.onSuccess({ ...reviewOne, status: "decided" }, { id: reviewOne.id });

    // Cache stays as-is until the invalidate-triggered refetch resolves.
    // Tests assert the invalidate call fires; the refetch itself is React
    // Query's territory.
    const cache = qc.getQueryData<ReviewListCache>([...DECIDED_KEY]);
    expect(cache?.items).toEqual([reviewTwo]);
  });

  it("invalidateOnSuccess fires against ['reviews'] prefix (Undo triggers refetch)", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewTwo]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = buildOptimisticLifecycle(qc, unarchiveOptions);

    await lifecycle.onMutate({ id: reviewOne.id });
    lifecycle.onSuccess({ ...reviewOne, status: "decided" }, { id: reviewOne.id });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REVIEWS_PREFIX });
  });

  it("rollback is a no-op (no onOptimistic patch) and error surfaces via toast", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewTwo]);
    const lifecycle = buildOptimisticLifecycle(qc, unarchiveOptions);

    const snapshots = await lifecycle.onMutate({ id: reviewOne.id });
    lifecycle.onError(new ApiError(404, "not found or not archived"), { id: reviewOne.id }, snapshots);

    const cache = qc.getQueryData<ReviewListCache>([...DECIDED_KEY]);
    expect(cache?.items).toEqual([reviewTwo]); // untouched
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// ── archive → Undo → unarchive roundtrip ────────────────────────────────────

describe("archive → Undo → unarchive full cycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("archive removes from visible cache; unarchive invalidates for a fresh fetch", async () => {
    const qc = makeQueryClient();
    seed(qc, [reviewOne, reviewTwo]);
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const archiveLifecycle = buildOptimisticLifecycle(qc, archiveOptions);
    const unarchiveLifecycle = buildOptimisticLifecycle(qc, unarchiveOptions);

    // 1. User clicks Archive. Optimistic removal.
    await archiveLifecycle.onMutate({ id: reviewOne.id });
    let cache = qc.getQueryData<ReviewListCache>([...DECIDED_KEY]);
    expect(cache?.items).toEqual([reviewTwo]);

    // 2. Server confirms archive. Broad invalidate to pick up the transition
    //    on other pages + the typed ["reviews","list",...] keys.
    archiveLifecycle.onSuccess({ ...reviewOne, status: "archived" }, { id: reviewOne.id });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REVIEWS_PREFIX });

    // 3. User clicks Undo on the toast. Fires unarchive mutation.
    await unarchiveLifecycle.onMutate({ id: reviewOne.id });
    unarchiveLifecycle.onSuccess({ ...reviewOne, status: "decided" }, { id: reviewOne.id });

    // 4. Invalidate fires again; the next refetch will pull the restored
    //    review back into the list (verified indirectly via the spy).
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
