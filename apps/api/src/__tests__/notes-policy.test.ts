import { describe, it, expect } from "vitest";
import { can } from "../policy/can";
import type { Subject } from "../policy/subjects";

describe("notes policy scopes", () => {
  const sessionAdmin: Subject = { kind: "session", userId: "u1", role: "admin" };
  const sessionReviewer: Subject = { kind: "session", userId: "u2", role: "reviewer" };

  it("admin has notes:delete_any_shared", () => {
    expect(can(sessionAdmin, ["notes:delete_any_shared"]).allow).toBe(true);
  });

  it("reviewer does NOT have notes:delete_any_shared", () => {
    expect(can(sessionReviewer, ["notes:delete_any_shared"]).allow).toBe(false);
  });

  it("reviewer has notes:write + notes:edit_own + notes:delete_own", () => {
    expect(can(sessionReviewer, ["notes:write"]).allow).toBe(true);
    expect(can(sessionReviewer, ["notes:edit_own"]).allow).toBe(true);
    expect(can(sessionReviewer, ["notes:delete_own"]).allow).toBe(true);
  });
});
