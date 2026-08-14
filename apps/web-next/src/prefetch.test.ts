import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@gatewerk/web-core/api/client/http", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@gatewerk/web-core/api/client/http")>();
  return { ...mod, isAuthenticated: () => mockAuthed, request: vi.fn(async () => ({})) };
});
let mockAuthed = true;

import { bootPrefetch, prefetchRoute, sessionPrefetch } from "./prefetch";

afterEach(() => {
  mockAuthed = true;
  window.history.replaceState(null, "", "/");
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("prefetchRoute", () => {
  it("seeds the cache entries for the pathname", async () => {
    const qc = client();
    prefetchRoute(qc, "/history");
    // prefetchQuery inserts the query synchronously, fetch settles async.
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(["reviews", "history", "decided"]);
    expect(keys).toContainEqual(["reviews", "history", "expired"]);
  });

  it("does nothing signed out", () => {
    mockAuthed = false;
    const qc = client();
    prefetchRoute(qc, "/history");
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("bootPrefetch", () => {
  it("seeds shell queries plus the current route", () => {
    const qc = client();
    window.history.replaceState(null, "", "/templates");
    bootPrefetch(qc);
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(["reviews", "pending"]);
    expect(keys).toContainEqual(["notifications", "unread-count"]);
    expect(keys).toContainEqual(["templates"]);
  });

  it("does nothing on /login even when authenticated", () => {
    const qc = client();
    window.history.replaceState(null, "", "/login");
    bootPrefetch(qc);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("sessionPrefetch", () => {
  it("lets prefetchRoute proceed once ready, even when isAuthenticated() is false", async () => {
    // Module state (sessionReady) persists for the life of the module
    // instance — reset it via a fresh import so this test doesn't leak into
    // the "does nothing signed out" case above or vice versa.
    vi.resetModules();
    const fresh = await import("./prefetch");
    mockAuthed = false;
    const qc = client();
    window.history.replaceState(null, "", "/templates");
    fresh.sessionPrefetch(qc);
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual(["reviews", "pending"]);
    expect(keys).toContainEqual(["notifications", "unread-count"]);
    expect(keys).toContainEqual(["templates"]);

    // A later, independent prefetchRoute call also proceeds now that
    // sessionReady is set — this is the cloud-mode hover/focus path.
    const qc2 = client();
    fresh.prefetchRoute(qc2, "/history");
    const keys2 = qc2.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys2).toContainEqual(["reviews", "history", "decided"]);
  });
});
