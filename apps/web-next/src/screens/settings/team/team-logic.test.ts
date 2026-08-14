import { describe, it, expect } from "vitest";
import type { TeamMember } from "@gatewerk/web-core/api/notifications";
import { ROLE_OPTIONS, activeMembers, buildInviteBody, canRemoveMember, roleBadgeLabel } from "./team-logic";

function member(overrides: Partial<TeamMember>): TeamMember {
  return {
    id: "rev_1",
    email: "a@b.com",
    name: "A",
    role: "reviewer",
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ROLE_OPTIONS", () => {
  it("offers exactly reviewer and admin, never owner", () => {
    expect(ROLE_OPTIONS.map((o) => o.value)).toEqual(["reviewer", "admin"]);
  });
});

describe("canRemoveMember", () => {
  it("is true for another member", () => {
    expect(canRemoveMember("rev_2", "rev_1")).toBe(true);
  });

  it("is false for yourself", () => {
    expect(canRemoveMember("rev_1", "rev_1")).toBe(false);
  });

  it("is true when there is no current user yet (auth still loading)", () => {
    expect(canRemoveMember("rev_1", undefined)).toBe(true);
  });
});

describe("buildInviteBody", () => {
  it("trims the email and keeps the chosen role", () => {
    expect(buildInviteBody("  jane@company.com  ", "admin")).toEqual({
      email: "jane@company.com",
      role: "admin",
    });
  });

  it("defaults an unrecognized role to reviewer", () => {
    expect(buildInviteBody("jane@company.com", "owner")).toEqual({
      email: "jane@company.com",
      role: "reviewer",
    });
  });
});

describe("roleBadgeLabel", () => {
  it("title-cases known roster roles, including owner (Cloud workspaces) though it's not an invite option", () => {
    expect(roleBadgeLabel("admin")).toBe("Admin");
    expect(roleBadgeLabel("reviewer")).toBe("Reviewer");
    expect(roleBadgeLabel("owner")).toBe("Owner");
  });

  it("falls back to the raw string for anything unrecognized", () => {
    expect(roleBadgeLabel("bogus")).toBe("bogus");
  });
});

describe("activeMembers", () => {
  it("drops soft-deleted members — GET /settings/team returns everyone, this section has no reactivate control", () => {
    const active = member({ id: "rev_1", is_active: true });
    const removed = member({ id: "rev_2", is_active: false });
    expect(activeMembers([active, removed])).toEqual([active]);
  });

  it("keeps an all-active roster untouched", () => {
    const roster = [member({ id: "rev_1" }), member({ id: "rev_2" })];
    expect(activeMembers(roster)).toEqual(roster);
  });
});
