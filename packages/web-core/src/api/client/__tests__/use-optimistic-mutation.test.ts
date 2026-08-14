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
import { buildOptimisticLifecycle } from "../use-optimistic-mutation";
import { ApiError } from "../http";

interface Review {
  id: string;
  status: string;
  version: number;
  decided_at: string | null;
}

type DecideInput = { id: string; decision: "approved" | "rejected" };

const baseReview: Review = {
  id: "rev_1",
  status: "pending",
  version: 1,
  decided_at: null,
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeLifecycle(qc: QueryClient, overrides: Partial<Parameters<typeof buildOptimisticLifecycle<DecideInput, Review>>[1]> = {}) {
  return buildOptimisticLifecycle<DecideInput, Review>(qc, {
    keys: ({ id }) => [["review", id]],
    onOptimistic: (prev, { decision }) => {
      if (!prev) return undefined;
      return { ...(prev as Review), status: decision, decided_at: "2026-04-18T00:00:00Z" };
    },
    onServerResponse: (_prev, response) => response,
    ...overrides,
  });
}

describe("buildOptimisticLifecycle — happy path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("snapshots previous cache and writes the optimistic patch", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });

    expect(snapshots).toEqual([{ key: ["review", "rev_1"], prev: baseReview }]);
    expect(qc.getQueryData(["review", "rev_1"])).toMatchObject({
      status: "approved",
      decided_at: "2026-04-18T00:00:00Z",
    });
  });

  it("skips optimistic patch when nothing is cached for the key", async () => {
    const qc = makeQueryClient();
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ id: "rev_missing", decision: "approved" });

    expect(snapshots).toEqual([{ key: ["review", "rev_missing"], prev: undefined }]);
    expect(qc.getQueryData(["review", "rev_missing"])).toBeUndefined();
  });

  it("replaces optimistic state with server response on success", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({ id: "rev_1", decision: "approved" });

    const serverResponse: Review = {
      id: "rev_1",
      status: "approved",
      version: 2,
      decided_at: "2026-04-18T00:00:05Z",
    };
    lifecycle.onSuccess(serverResponse, { id: "rev_1", decision: "approved" });

    expect(qc.getQueryData(["review", "rev_1"])).toEqual(serverResponse);
  });

  it("invalidates prefix keys listed in invalidateOnSuccess", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    qc.setQueryData(["reviews", "list", {}], { items: [baseReview], total: 1, has_more: false });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = buildOptimisticLifecycle<DecideInput, Review>(qc, {
      keys: ({ id }) => [["review", id]],
      onServerResponse: (_prev, response) => response,
      invalidateOnSuccess: () => [["reviews"]],
    });

    await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    lifecycle.onSuccess({ ...baseReview, status: "approved" }, { id: "rev_1", decision: "approved" });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews"] });
  });
});

describe("buildOptimisticLifecycle — rollback paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores the snapshot on 500 and surfaces request_id in the toast", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    expect(qc.getQueryData(["review", "rev_1"])).toMatchObject({ status: "approved" });

    const err = new ApiError(500, "boom", undefined, "req_zzz");
    lifecycle.onError(err, { id: "rev_1", decision: "approved" }, snapshots);

    expect(qc.getQueryData(["review", "rev_1"])).toEqual(baseReview);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("req_zzz");
  });

  it("restores the snapshot on 409 and still surfaces a warning toast when no handler suppresses", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });

    const err = new ApiError(409, "already decided", "review_already_decided");
    lifecycle.onError(err, { id: "rev_1", decision: "approved" }, snapshots);

    expect(qc.getQueryData(["review", "rev_1"])).toEqual(baseReview);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("honours onMappedError returning false by suppressing the default toast", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const onMappedError = vi.fn().mockReturnValue(false);
    const lifecycle = buildOptimisticLifecycle<DecideInput, Review>(qc, {
      keys: ({ id }) => [["review", id]],
      onOptimistic: (prev, { decision }) => (prev ? { ...(prev as Review), status: decision } : undefined),
      onServerResponse: (_prev, response) => response,
      onMappedError,
    });

    const snapshots = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });

    const err = new ApiError(409, "version mismatch", "version_mismatch");
    lifecycle.onError(err, { id: "rev_1", decision: "approved" }, snapshots);

    expect(onMappedError).toHaveBeenCalledTimes(1);
    expect(onMappedError.mock.calls[0]?.[0].code).toBe("version_mismatch");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(qc.getQueryData(["review", "rev_1"])).toEqual(baseReview);
  });

  it("is a no-op on rollback when onMutate returned no snapshots (defensive)", () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    lifecycle.onError(new ApiError(500, "x"), { id: "rev_1", decision: "approved" }, undefined);

    expect(qc.getQueryData(["review", "rev_1"])).toEqual(baseReview);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe("buildOptimisticLifecycle — concurrent-mutation caveat (documented behaviour)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("second onMutate captures the first's optimistic state as its snapshot (v1 limitation)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["review", "rev_1"], baseReview);
    const lifecycle = makeLifecycle(qc);

    const first = await lifecycle.onMutate({ id: "rev_1", decision: "approved" });
    const second = await lifecycle.onMutate({ id: "rev_1", decision: "rejected" });

    expect(first[0]?.prev).toEqual(baseReview);
    expect((second[0]?.prev as Review).status).toBe("approved");

    lifecycle.onError(new ApiError(500, "fail"), { id: "rev_1", decision: "rejected" }, second);
    expect((qc.getQueryData(["review", "rev_1"]) as Review).status).toBe("approved");
  });
});
