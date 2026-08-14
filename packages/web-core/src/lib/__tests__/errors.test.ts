import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { mapError, showMappedError } from "../errors";
import { ApiError } from "../../api/client/http";

describe("mapError", () => {
  it("maps 401 to auth kind with generic signed-out copy", () => {
    const m = mapError(new ApiError(401, "Unauthorized", undefined, "req_123"));
    expect(m.kind).toBe("auth");
    expect(m.status).toBe(401);
    expect(m.requestId).toBe("req_123");
  });

  it("maps 403 to forbidden and preserves server message", () => {
    const m = mapError(new ApiError(403, "insufficient_scope"));
    expect(m.kind).toBe("forbidden");
    expect(m.message).toBe("insufficient_scope");
  });

  it("maps 404 to not_found", () => {
    const m = mapError(new ApiError(404, "Review not found"));
    expect(m.kind).toBe("not_found");
  });

  it("maps 409 to conflict and carries the server error code", () => {
    const m = mapError(new ApiError(409, "already decided", "review_already_decided"));
    expect(m.kind).toBe("conflict");
    expect(m.code).toBe("review_already_decided");
  });

  it("maps 422 to validation", () => {
    const m = mapError(new ApiError(422, "Invalid"));
    expect(m.kind).toBe("validation");
  });

  it("maps 5xx to server and appends request_id to the message", () => {
    const m = mapError(new ApiError(500, "db exploded", undefined, "req_abc"));
    expect(m.kind).toBe("server");
    expect(m.message).toContain("db exploded");
    expect(m.message).toContain("req_abc");
  });

  it("falls back to network kind for fetch-style Errors", () => {
    const m = mapError(new Error("Failed to fetch"));
    expect(m.kind).toBe("network");
  });

  it("defaults unknown kind for non-Error values", () => {
    const m = mapError("boom");
    expect(m.kind).toBe("unknown");
  });
});

describe("showMappedError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes server/validation/auth to toast.error", () => {
    showMappedError({ kind: "server", status: 500, title: "t", message: "m" });
    expect(toast.error).toHaveBeenCalledWith("m", undefined);
  });

  it("routes conflict/forbidden/not_found to toast.warning", () => {
    showMappedError({ kind: "conflict", status: 409, title: "t", message: "m" });
    expect(toast.warning).toHaveBeenCalledWith("m", undefined);
  });

  it("forwards action to sonner action prop", () => {
    const handler = vi.fn();
    showMappedError({
      kind: "conflict",
      status: 409,
      title: "t",
      message: "m",
      action: { label: "Refresh", handler },
    });
    expect(toast.warning).toHaveBeenCalledWith("m", {
      action: { label: "Refresh", onClick: handler },
    });
  });
});
