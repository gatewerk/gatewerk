import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "react-router";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

import { handleLiveEvent } from "../live-event-handler";
import { toast } from "sonner";

// The dispatcher must
// invalidate ["review-chain", reviewId] when the wire payload carries
// chain_run_id, in addition to the always-invalidate ["reviews"] prefix.
// Non-chain events must not touch the chain queryKey.

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const navigate = vi.fn() as unknown as ReturnType<typeof useNavigate>;

describe("handleLiveEvent — chain queryKey invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates ['review-chain', reviewId] when chain_run_id is present in the payload", () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    handleLiveEvent(
      {
        type: "review.decided",
        review_id: "gw_rev_chain_77",
        project_id: "gw_prj_1",
        template_slug: "approval",
        priority: "normal",
        created_at: "2026-04-29T10:00:00Z",
        chain_run_id: "gw_chain_xyz",
        chain_step_id: "gw_step_abc",
        step_index: 2,
        total_steps: 3,
      },
      { navigate, queryClient: qc },
    );

    // Both invalidations fired — the always-invalidate ["reviews"] prefix
    // and the chain-specific ["review-chain", reviewId] key.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["review-chain", "gw_rev_chain_77"],
    });
  });

  it("does NOT invalidate the chain queryKey when chain_run_id is absent", () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    handleLiveEvent(
      {
        type: "review.decided",
        review_id: "gw_rev_plain_88",
        project_id: "gw_prj_1",
        template_slug: "approval",
        priority: "normal",
        created_at: "2026-04-29T10:00:00Z",
        // no chain_run_id — non-chain review.
      },
      { navigate, queryClient: qc },
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["reviews"] });
    // Crucially, no call carrying ["review-chain", ...] queryKey.
    const chainCalls = invalidateSpy.mock.calls.filter((args) => {
      const arg = args[0] as { queryKey?: unknown[] } | undefined;
      return Array.isArray(arg?.queryKey) && arg!.queryKey![0] === "review-chain";
    });
    expect(chainCalls).toHaveLength(0);
  });

  it("does nothing on the open frame (no chain queryKey touched either)", () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    handleLiveEvent({ type: "open" }, { navigate, queryClient: qc });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("handleLiveEvent — review.created toast deep-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Node has no localStorage; stub it so shouldShowToast's first-call
    // returns true (getItem returns null → no prior entry → writes key → true).
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toast action.onClick navigates to /?review=<id>, not /reviews/<id>", () => {
    const qc = makeQueryClient();
    const toastMock = vi.mocked(toast.info);

    handleLiveEvent(
      {
        type: "review.created",
        review_id: "gw_rev_toast_99",
        project_id: "gw_prj_1",
        template_slug: "approval",
        priority: "normal",
        created_at: "2026-06-16T12:00:00Z",
      },
      { navigate, queryClient: qc },
    );

    expect(toastMock).toHaveBeenCalledOnce();
    const [, options] = toastMock.mock.calls[0];
    const action = (options as unknown as { action: { onClick: (e?: unknown) => void } }).action;
    action.onClick(); // event arg omitted intentionally — production handler ignores it

    expect(navigate).toHaveBeenCalledWith("/?review=gw_rev_toast_99", { viewTransition: true });
  });
});
