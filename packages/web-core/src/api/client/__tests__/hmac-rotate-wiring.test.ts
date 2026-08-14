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

// Shape mirrors for the HMAC secret cache + rotate response. The real typed
// schemas live in `@gatewerk/shared/api/schemas/projects`; tests use a local
// minimal shape so the cache semantics stay testable independent of schema
// drift. If the wire shapes gain fields, these locals need a touch; the
// helper config stays the source of truth.
//
// The preview cache stores only
// `{ prefix, has_secret }`; rotate response still carries the full secret
// but the cache projection strips it down. See `webhooks/_options.ts`
// `hmacRotateOptions`.
type HmacPreviewCache = { prefix: string; has_secret: boolean };
type HmacRotateResponse = { hmac_secret: string };

const HMAC_KEY = ["settings", "hmac-secret"] as const;

const hmacRotateOptions: OptimisticMutationOptions<Record<string, never>, HmacRotateResponse> = {
  keys: () => [HMAC_KEY],
  onServerResponse: (_prev, response) => ({
    prefix: response.hmac_secret.slice(0, 8),
    has_secret: true,
  }),
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe("hmacRotate wiring — useOptimisticMutation config for rotateHmacSecret", () => {
  beforeEach(() => vi.clearAllMocks());

  it("projects the rotate response onto the preview cache (prefix = first 8 of new secret)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData<HmacPreviewCache>([...HMAC_KEY], { prefix: "oldxxxxx", has_secret: true });
    const lifecycle = buildOptimisticLifecycle(qc, hmacRotateOptions);

    await lifecycle.onMutate({});
    lifecycle.onSuccess({ hmac_secret: "new-secret-xyz-64-chars-long-for-this-test-0123456789abcdef" }, {});

    expect(qc.getQueryData<HmacPreviewCache>([...HMAC_KEY])).toEqual({
      prefix: "new-secr",
      has_secret: true,
    });
  });

  it("populates the preview cache from the rotate response even when nothing was cached yet", async () => {
    const qc = makeQueryClient();
    const lifecycle = buildOptimisticLifecycle(qc, hmacRotateOptions);

    await lifecycle.onMutate({});
    lifecycle.onSuccess({ hmac_secret: "new-secret-xyz-64-chars-long-for-this-test-0123456789abcdef" }, {});

    expect(qc.getQueryData<HmacPreviewCache>([...HMAC_KEY])).toEqual({
      prefix: "new-secr",
      has_secret: true,
    });
  });

  it("rollback is a no-op (no onOptimistic patch was applied) and toast surfaces the error", async () => {
    const qc = makeQueryClient();
    qc.setQueryData<HmacPreviewCache>([...HMAC_KEY], { prefix: "oldxxxxx", has_secret: true });
    const lifecycle = buildOptimisticLifecycle(qc, hmacRotateOptions);

    const snapshots = await lifecycle.onMutate({});
    lifecycle.onError(new ApiError(500, "rotation failed", "internal_error", "req-42"), {}, snapshots);

    // Cache untouched — no optimistic patch was applied.
    expect(qc.getQueryData<HmacPreviewCache>([...HMAC_KEY])).toEqual({ prefix: "oldxxxxx", has_secret: true });
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [msg] = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(msg)).toContain("req-42");
  });

  it("surfaces 403 via the warning toast (permission denied is not a server fault)", async () => {
    const qc = makeQueryClient();
    qc.setQueryData<HmacPreviewCache>([...HMAC_KEY], { prefix: "oldxxxxx", has_secret: true });
    const lifecycle = buildOptimisticLifecycle(qc, hmacRotateOptions);

    const snapshots = await lifecycle.onMutate({});
    lifecycle.onError(new ApiError(403, "admin only"), {}, snapshots);

    expect(qc.getQueryData<HmacPreviewCache>([...HMAC_KEY])).toEqual({ prefix: "oldxxxxx", has_secret: true });
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});
