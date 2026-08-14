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
  status: "draft" | "active";
}

interface TemplateListPage {
  items: Template[];
  total: number;
  has_more: boolean;
}

type CreateDraftInput = Record<string, never>;

const emptyList: TemplateListPage = { items: [], total: 0, has_more: false };
const existing: Template = { id: "tmpl_1", slug: "report", name: "Report", status: "active" };
const listWithOne: TemplateListPage = { items: [existing], total: 1, has_more: false };

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeLifecycle(qc: QueryClient) {
  return buildOptimisticLifecycle<CreateDraftInput, Template>(qc, {
    keys: () => [["templates"]],
    onServerResponse: (prev, response) => {
      if (!prev) return undefined;
      const list = prev as TemplateListPage;
      return { ...list, items: [response, ...list.items], total: list.total + 1 };
    },
  });
}

describe("createDraft wiring — useOptimisticMutation config for template create-draft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepends the server-created draft to the list cache and bumps total", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], listWithOne);
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({});
    const created: Template = { id: "tmpl_new", slug: "", name: "", status: "draft" };
    lifecycle.onSuccess(created, {});

    const next = qc.getQueryData<TemplateListPage>(["templates"]);
    expect(next?.items[0]).toEqual(created);
    expect(next?.items[1]).toEqual(existing);
    expect(next?.total).toBe(2);
  });

  it("preserves an empty list when there is no cache entry yet", async () => {
    const qc = makeQueryClient();
    const lifecycle = makeLifecycle(qc);

    await lifecycle.onMutate({});
    const created: Template = { id: "tmpl_new", slug: "", name: "", status: "draft" };
    lifecycle.onSuccess(created, {});

    expect(qc.getQueryData(["templates"])).toBeUndefined();
  });

  it("snapshot rollback is a no-op under error because the lifecycle never applies onOptimistic", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], listWithOne);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({});
    lifecycle.onError(new ApiError(500, "boom"), {}, snapshots);

    expect(qc.getQueryData(["templates"])).toEqual(listWithOne);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("preserves the initial cache on error even with an empty starting list", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["templates"], emptyList);
    const lifecycle = makeLifecycle(qc);

    const snapshots = await lifecycle.onMutate({});
    lifecycle.onError(new ApiError(500, "boom"), {}, snapshots);

    expect(qc.getQueryData(["templates"])).toEqual(emptyList);
  });
});
