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
import { buildOptimisticLifecycle, type OptimisticMutationOptions } from "../use-optimistic-mutation";
import { ApiError } from "../http";

// Wiring tests for the production `bulkDecideOptions` defined in Inbox.tsx.
// Shape mirrors the in-component declaration exactly. Critical property: per-mutation
// `keys` returns `[["review", id]]` — DISJOINT across concurrent calls, the only
// safe shape for Promise.allSettled fan-out (shared keys serialize the mutations).

interface Review {
  id: string;
  status: string;
  decided_at: string | null;
}
type BulkDecideInput = { id: string; decision: string };

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function bulkDecideOptions(): OptimisticMutationOptions<BulkDecideInput, Review> {
  return {
    keys: ({ id }) => [["review", id]],
    onOptimistic: (prev, { decision }) => {
      if (!prev) return undefined;
      return {
        ...(prev as Review),
        status: decision,
        decided_at: "optimistic-ts",
      };
    },
    onServerResponse: (_prev, response) => response,
    onMappedError: () => false,
  };
}

describe("bulk decide wiring — per-id disjoint-key fan-out", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keys() returns a unique cache key per input id (disjoint across concurrent calls)", async () => {
    const qc = makeQueryClient();
    const lifecycle = buildOptimisticLifecycle(qc, bulkDecideOptions());

    const s1 = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    const s2 = await lifecycle.onMutate({ id: "rev_2", decision: "rejected" });

    expect(s1[0].key).toEqual(["review", "rev_1"]);
    expect(s2[0].key).toEqual(["review", "rev_2"]);
    expect(s1[0].key).not.toEqual(s2[0].key);
  });

  it("happy path: optimistic patch on seeded review, server response replaces on success", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], { id: "rev_1", status: "pending", decided_at: null });
    const lifecycle = buildOptimisticLifecycle(qc, bulkDecideOptions());

    await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    expect(qc.getQueryData<Review>(["review", "rev_1"])).toMatchObject({
      status: "approved",
      decided_at: "optimistic-ts",
    });

    lifecycle.onSuccess(
      { id: "rev_1", status: "approved", decided_at: "server-ts" },
      { id: "rev_1", decision: "approved" },
    );
    expect(qc.getQueryData<Review>(["review", "rev_1"])).toMatchObject({
      decided_at: "server-ts",
    });
  });

  it("rollback: error restores the per-id snapshot, other ids untouched", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], { id: "rev_1", status: "pending", decided_at: null });
    qc.setQueryData(["review", "rev_2"], { id: "rev_2", status: "pending", decided_at: null });
    const lifecycle = buildOptimisticLifecycle(qc, bulkDecideOptions());

    const s1 = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    await lifecycle.onMutate({ id: "rev_2", decision: "rejected" });

    // rev_1 fails
    lifecycle.onError(new ApiError(409, "already decided", "review_already_decided"), { id: "rev_1", decision: "approved" }, s1);

    // rev_1 rolled back to pending; rev_2 remains with its optimistic rejected state.
    expect(qc.getQueryData<Review>(["review", "rev_1"])?.status).toBe("pending");
    expect(qc.getQueryData<Review>(["review", "rev_2"])?.status).toBe("rejected");
  });

  it("onMappedError returns false: helper suppresses its default toast (aggregate owner emits one instead)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], { id: "rev_1", status: "pending", decided_at: null });
    const lifecycle = buildOptimisticLifecycle(qc, bulkDecideOptions());

    const s = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    lifecycle.onError(new ApiError(500, "server fault", "internal_error", "req-abc"), { id: "rev_1", decision: "approved" }, s);

    // Per-mutation default toast is suppressed (onMappedError returned false).
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("defensive: input with id not in cache skips optimistic patch but still records snapshot", async () => {
    const qc = makeQueryClient();
    const lifecycle = buildOptimisticLifecycle(qc, bulkDecideOptions());

    const s = await lifecycle.onMutate({ id: "rev_missing", decision: "approved" });

    expect(s).toEqual([{ key: ["review", "rev_missing"], prev: undefined }]);
    expect(qc.getQueryData(["review", "rev_missing"])).toBeUndefined();
  });
});
