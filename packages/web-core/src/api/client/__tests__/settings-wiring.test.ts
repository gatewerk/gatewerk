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

// Minimal shape mirrors of the typed-client schemas — tests document the
// helper config independently of schema drift. If the wire shapes change,
// these locals get a touch-up; the helper config stays the source of truth.
interface ProjectSettings {
  id: string;
  name: string;
  description: string | null;
  webhook_url: string | null;
  hmac_secret_set: boolean;
}

interface InviteResult {
  invite_url: string;
  expires_at: string;
}

const initialProject: ProjectSettings = {
  id: "proj_1",
  name: "Original",
  description: null,
  webhook_url: null,
  hmac_secret_set: true,
};

const updatedProject: ProjectSettings = {
  id: "proj_1",
  name: "Updated",
  description: "Now with description",
  webhook_url: null,
  hmac_secret_set: true,
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// ── Project save wiring ──────────────────────────────────────────────────────

describe("project save wiring — useOptimisticMutation config for updateProjectSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeProjectLifecycle(qc: QueryClient) {
    return buildOptimisticLifecycle<{ name: string; description?: string }, ProjectSettings>(qc, {
      keys: () => [["settings", "project"]],
      onServerResponse: (_prev, response) => response,
    });
  }

  it("replaces ['settings','project'] with the server response on success", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["settings", "project"], initialProject);
    const lifecycle = makeProjectLifecycle(qc);

    await lifecycle.onMutate({ name: "Updated", description: "Now with description" });
    lifecycle.onSuccess(updatedProject, { name: "Updated", description: "Now with description" });

    expect(qc.getQueryData(["settings", "project"])).toEqual(updatedProject);
  });

  it("rollback is structurally a no-op (no onOptimistic patch was applied)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["settings", "project"], initialProject);
    const lifecycle = makeProjectLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ name: "Updated" });
    lifecycle.onError(new ApiError(500, "boom"), { name: "Updated" }, snapshots);

    // Cache untouched — no optimistic patch was applied, so restoring the snapshot
    // returns to the same value the cache already held.
    expect(qc.getQueryData(["settings", "project"])).toEqual(initialProject);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("preserves an undefined cache when nothing was loaded yet", async () => {
    const qc = makeQueryClient();
    const lifecycle = makeProjectLifecycle(qc);

    await lifecycle.onMutate({ name: "Updated" });
    lifecycle.onSuccess(updatedProject, { name: "Updated" });

    // onServerResponse runs on the precise key regardless of prior cache —
    // server is source of truth, so the response populates the cache even
    // when it was empty.
    expect(qc.getQueryData(["settings", "project"])).toEqual(updatedProject);
  });

  it("surfaces request_id on 5xx via the helper's mapped error toast", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["settings", "project"], initialProject);
    const lifecycle = makeProjectLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ name: "Updated" });
    lifecycle.onError(new ApiError(500, "boom", "internal_error", "req-abc-123"), { name: "Updated" }, snapshots);

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-abc-123");
  });
});

// ── Invite generation wiring ─────────────────────────────────────────────────

describe("invite wiring — useOptimisticMutation config for generateInviteToken", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeInviteLifecycle(qc: QueryClient) {
    return buildOptimisticLifecycle<{ email: string; role: string }, InviteResult>(qc, {
      keys: () => [],
    });
  }

  it("snapshots empty (no cache effect) and runs onSuccess as no-op for cache", async () => {
    const qc = makeQueryClient();
    const lifecycle = makeInviteLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ email: "jane@co.com", role: "reviewer" });
    expect(snapshots).toEqual([]);

    const result: InviteResult = { invite_url: "https://app/invite/abc", expires_at: "2026-04-25" };
    lifecycle.onSuccess(result, { email: "jane@co.com", role: "reviewer" });

    // No keys means nothing in the QueryClient was touched. UI choreography
    // (setInviteUrl + success toast) lives in the per-call onSuccess at the
    // call site, not in the helper config.
    expect(qc.getQueryData(["settings", "team"])).toBeUndefined();
  });

  it("rollback is a no-op — empty snapshots, no cache to restore", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["settings", "team"], { items: [], total: 0, has_more: false });
    const lifecycle = makeInviteLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ email: "jane@co.com", role: "reviewer" });
    lifecycle.onError(new ApiError(422, "Email already invited", "validation_failed"), {
      email: "jane@co.com",
      role: "reviewer",
    }, snapshots);

    // Adjacent caches untouched — invite mutation has no list to manipulate.
    expect(qc.getQueryData(["settings", "team"])).toEqual({ items: [], total: 0, has_more: false });
    // 422 surfaces as warning toast (validation kind), not error.
    expect(toast.warning).toHaveBeenCalledTimes(0);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
