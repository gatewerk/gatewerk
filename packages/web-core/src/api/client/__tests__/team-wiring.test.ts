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

// Minimal shape mirrors. The real TeamMember type has an optional `object`
// literal, an optional `last_login_at`, and `created_at` — the tests use a
// reduced shape because the helper's cache semantics only exercise id/name/
// role/is_active.
interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}

interface TeamListCache {
  object: "list";
  items: TeamMember[];
  has_more: boolean;
  total: number;
}

function isTeamList(x: unknown): x is TeamListCache {
  return !!x && typeof x === "object" && "items" in x && Array.isArray((x as { items: unknown }).items);
}

const TEAM_KEY = ["settings", "team"] as const;

type UpdateInput = {
  id: string;
  name?: string;
  role?: string;
  is_active?: boolean;
};

const teamUpdateOptions: OptimisticMutationOptions<UpdateInput, TeamMember> = {
  keys: () => [TEAM_KEY],
  onOptimistic: (prev, input) => {
    if (!isTeamList(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.map((m) => (m.id === input.id ? { ...m, ...input } : m)),
    };
  },
  onServerResponse: (prev, response, input) => {
    if (!isTeamList(prev)) return undefined;
    return { ...prev, items: prev.items.map((m) => (m.id === input.id ? response : m)) };
  },
};

const teamDeleteOptions: OptimisticMutationOptions<{ id: string }, void> = {
  keys: () => [TEAM_KEY],
  onOptimistic: (prev, input) => {
    if (!isTeamList(prev)) return undefined;
    return {
      ...prev,
      items: prev.items.filter((m) => m.id !== input.id),
      total: Math.max(0, prev.total - 1),
    };
  },
};

const alice: TeamMember = {
  id: "tm_1",
  email: "alice@co.com",
  name: "Alice",
  role: "admin",
  is_active: true,
};

const bob: TeamMember = {
  id: "tm_2",
  email: "bob@co.com",
  name: "Bob",
  role: "reviewer",
  is_active: true,
};

function seed(qc: QueryClient, items: TeamMember[]): void {
  qc.setQueryData<TeamListCache>([...TEAM_KEY], {
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

// ── update (form save path) ──────────────────────────────────────────────────

describe("updateTeamMember wiring (form save)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically merges name + role onto the cached row", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice, bob]);
    const lifecycle = buildOptimisticLifecycle(qc, teamUpdateOptions);

    await lifecycle.onMutate({ id: alice.id, name: "Alice B.", role: "reviewer" });

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    const patched = cache?.items.find((m) => m.id === alice.id);
    expect(patched?.name).toBe("Alice B.");
    expect(patched?.role).toBe("reviewer");
    expect(patched?.is_active).toBe(true); // untouched
    // Adjacent row untouched.
    expect(cache?.items.find((m) => m.id === bob.id)).toEqual(bob);
  });

  it("server response replaces the row with canonical truth", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice]);
    const lifecycle = buildOptimisticLifecycle(qc, teamUpdateOptions);

    const serverResponse: TeamMember = { ...alice, name: "Alice B.", role: "reviewer" };

    await lifecycle.onMutate({ id: alice.id, name: "Alice B.", role: "reviewer" });
    lifecycle.onSuccess(serverResponse, { id: alice.id, name: "Alice B.", role: "reviewer" });

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items[0]).toEqual(serverResponse);
  });

  it("rollback restores snapshot on 500 and toast surfaces request_id", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice]);
    const lifecycle = buildOptimisticLifecycle(qc, teamUpdateOptions);

    const snapshots = await lifecycle.onMutate({ id: alice.id, name: "Alice B." });
    lifecycle.onError(
      new ApiError(500, "boom", "internal_error", "req-88"),
      { id: alice.id, name: "Alice B." },
      snapshots,
    );

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items).toEqual([alice]);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-88");
  });
});

// ── update (toggle path) ─────────────────────────────────────────────────────

describe("updateTeamMember wiring (toggle path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically flips is_active", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice]);
    const lifecycle = buildOptimisticLifecycle(qc, teamUpdateOptions);

    await lifecycle.onMutate({ id: alice.id, is_active: false });

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items[0].is_active).toBe(false);
    expect(cache?.items[0].name).toBe(alice.name); // untouched
  });

  it("rollback restores is_active when server rejects with 403", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice]);
    const lifecycle = buildOptimisticLifecycle(qc, teamUpdateOptions);

    const snapshots = await lifecycle.onMutate({ id: alice.id, is_active: false });
    lifecycle.onError(new ApiError(403, "admin only"), { id: alice.id, is_active: false }, snapshots);

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items[0].is_active).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// ── delete ───────────────────────────────────────────────────────────────────

describe("deleteTeamMember wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically removes + decrements total", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice, bob]);
    const lifecycle = buildOptimisticLifecycle(qc, teamDeleteOptions);

    await lifecycle.onMutate({ id: alice.id });

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items).toEqual([bob]);
    expect(cache?.total).toBe(1);
  });

  it("rollback restores both members on 404", async () => {
    const qc = makeQueryClient();
    seed(qc, [alice, bob]);
    const lifecycle = buildOptimisticLifecycle(qc, teamDeleteOptions);

    const snapshots = await lifecycle.onMutate({ id: alice.id });
    lifecycle.onError(new ApiError(404, "not found"), { id: alice.id }, snapshots);

    const cache = qc.getQueryData<TeamListCache>([...TEAM_KEY]);
    expect(cache?.items).toEqual([alice, bob]);
    expect(cache?.total).toBe(2);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("defensively bails when the cache is undefined (never seeded)", async () => {
    const qc = makeQueryClient();
    const lifecycle = buildOptimisticLifecycle(qc, teamDeleteOptions);

    const snapshots = await lifecycle.onMutate({ id: alice.id });
    lifecycle.onError(new ApiError(500, "boom"), { id: alice.id }, snapshots);

    // Cache untouched (never seeded), rollback restores the same undefined.
    expect(qc.getQueryData<TeamListCache>([...TEAM_KEY])).toBeUndefined();
  });
});
