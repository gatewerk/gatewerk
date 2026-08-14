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

interface Template {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "active" | "inactive";
  draft_config: unknown | null;
  published_at?: string | null;
}

interface TemplateListPage {
  items: Template[];
  total: number;
  has_more: boolean;
}

const draftRow: Template = {
  id: "tmpl_1",
  slug: "report",
  name: "Report",
  status: "draft",
  draft_config: { name: "Report", slug: "report" },
};
const otherRow: Template = {
  id: "tmpl_2",
  slug: "audit",
  name: "Audit",
  status: "active",
  draft_config: null,
};
const listBefore: TemplateListPage = { items: [draftRow, otherRow], total: 2, has_more: false };

// Server response: row transitioned draft → active, draft_config cleared, published_at set.
const serverTruth: Template = {
  id: "tmpl_1",
  slug: "report",
  name: "Report",
  status: "active",
  draft_config: null,
  published_at: "2026-04-18T12:00:00.000Z",
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeLifecycle(qc: QueryClient) {
  return buildOptimisticLifecycle<{ id: string }, Template>(qc, {
    keys: () => [["templates"]],
    onServerResponse: (prev, response) => {
      if (!prev) return undefined;
      const list = prev as TemplateListPage;
      return {
        ...list,
        items: list.items.map((t) => (t.id === response.id ? response : t)),
      };
    },
    invalidateOnSuccess: ({ id }) => [["templates", "detail", id]],
  });
}

describe("publishDraft wiring — useOptimisticMutation config for template publish", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replaces the target row in the list cache with the server response, leaves other rows intact", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], listBefore);
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({ id: "tmpl_1" });
    lifecycle.onSuccess(serverTruth, { id: "tmpl_1" });

    const next = qc.getQueryData<TemplateListPage>(["templates"]);
    expect(next?.items).toHaveLength(2);
    expect(next?.items[0]).toEqual(serverTruth);
    expect(next?.items[1]).toEqual(otherRow);
    expect(next?.total).toBe(2);
  });

  it("invalidates the detail-prefix cache on success so open subscriptions refetch server truth", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], listBefore);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({ id: "tmpl_1" });
    lifecycle.onSuccess(serverTruth, { id: "tmpl_1" });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["templates", "detail", "tmpl_1"] });
  });

  it("restores the list snapshot on error (no optimistic patch, so rollback returns to listBefore)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], listBefore);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({ id: "tmpl_1" });
    lifecycle.onError(new ApiError(500, "boom", undefined, "req_abc"), { id: "tmpl_1" }, snapshots);

    expect(qc.getQueryData(["templates"])).toEqual(listBefore);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty cache untouched (onServerResponse returns undefined when prev is absent)", async () => {
    const qc = makeQueryClient();
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({ id: "tmpl_1" });
    lifecycle.onSuccess(serverTruth, { id: "tmpl_1" });

    expect(qc.getQueryData(["templates"])).toBeUndefined();
  });
});
