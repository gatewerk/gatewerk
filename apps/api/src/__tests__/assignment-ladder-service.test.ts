import { describe, it, expect } from "vitest";
import { GatewerkError } from "@gatewerk/shared";
import type { AssignmentLadder } from "@gatewerk/shared";
import {
  validateLadder,
  initLadder,
  promoteLadder,
  MIN_TRIGGER_AFTER_SECONDS,
} from "../services/assignment-ladder";

const alice: AssignmentLadder[number] = { actor: "alice", trigger_after_seconds: 60 };
const manager: AssignmentLadder[number] = { actor: "manager", trigger_after_seconds: 7200 };
const admin: AssignmentLadder[number] = { actor: "admin", trigger_after_seconds: 14400 };

describe("AssignmentLadderService — validateLadder", () => {
  it("rejects a non-array value", () => {
    expect(() => validateLadder(null)).toThrowError(GatewerkError);
    expect(() => validateLadder({})).toThrowError(GatewerkError);
    expect(() => validateLadder("nope")).toThrowError(GatewerkError);
  });

  it("rejects an empty array", () => {
    expect(() => validateLadder([])).toThrowError(/non-empty array/);
  });

  it("rejects a step missing `actor` or with empty actor string", () => {
    expect(() => validateLadder([{ trigger_after_seconds: 60 } as any])).toThrowError(
      /actor must be a non-empty string/,
    );
    expect(() => validateLadder([{ actor: "", trigger_after_seconds: 60 }])).toThrowError(
      /actor must be a non-empty string/,
    );
  });

  it(`rejects trigger_after_seconds below ${MIN_TRIGGER_AFTER_SECONDS}`, () => {
    expect(() => validateLadder([{ actor: "alice", trigger_after_seconds: 30 }])).toThrowError(
      /trigger_after_seconds must be an integer >= 60/,
    );
  });

  it("rejects a non-integer trigger_after_seconds", () => {
    expect(() => validateLadder([{ actor: "alice", trigger_after_seconds: 60.5 }])).toThrowError(
      /trigger_after_seconds must be an integer/,
    );
  });

  it("rejects non-monotonic triggers (equal adjacent)", () => {
    expect(() =>
      validateLadder([
        { actor: "alice", trigger_after_seconds: 60 },
        { actor: "bob", trigger_after_seconds: 60 },
      ]),
    ).toThrowError(/strictly greater than the previous step/);
  });

  it("rejects non-monotonic triggers (decreasing)", () => {
    expect(() =>
      validateLadder([
        { actor: "alice", trigger_after_seconds: 7200 },
        { actor: "bob", trigger_after_seconds: 60 },
      ]),
    ).toThrowError(/strictly greater than the previous step/);
  });

  it("accepts a single-step ladder at the minimum trigger", () => {
    expect(() => validateLadder([alice])).not.toThrow();
  });

  it("accepts a 3-step ladder with monotonically increasing triggers", () => {
    expect(() => validateLadder([alice, manager, admin])).not.toThrow();
  });
});

describe("AssignmentLadderService — initLadder", () => {
  const createdAt = new Date("2026-04-23T10:00:00.000Z");

  it("sets index 0 to active and all others to pending", () => {
    const result = initLadder([alice, manager, admin], createdAt);
    expect(result.ladder_index).toBe(0);
    expect(result.ladder[0]).toEqual({ actor: "alice", trigger_after_seconds: 60, status: "active" });
    expect(result.ladder[1]).toEqual({ actor: "manager", trigger_after_seconds: 7200, status: "pending" });
    expect(result.ladder[2]).toEqual({ actor: "admin", trigger_after_seconds: 14400, status: "pending" });
  });

  it("computes ladder_next_promote_at as createdAt + ladder[1].trigger_after_seconds", () => {
    const result = initLadder([alice, manager, admin], createdAt);
    const expected = new Date(createdAt.getTime() + manager.trigger_after_seconds * 1000);
    expect(result.ladder_next_promote_at?.toISOString()).toBe(expected.toISOString());
  });

  it("returns null ladder_next_promote_at when ladder has a single step", () => {
    const result = initLadder([alice], createdAt);
    expect(result.ladder_next_promote_at).toBeNull();
  });

  it("exposes the step 0 actor as the initial assignee", () => {
    const result = initLadder([alice, manager], createdAt);
    expect(result.assignee).toBe("alice");
  });

  it("runs validateLadder internally (rejects invalid input)", () => {
    expect(() => initLadder([], createdAt)).toThrowError(/non-empty array/);
  });
});

describe("AssignmentLadderService — promoteLadder", () => {
  const createdAt = new Date("2026-04-23T10:00:00.000Z");
  const initialLadder: AssignmentLadder = [
    { actor: "alice", trigger_after_seconds: 60, status: "active" },
    { actor: "manager", trigger_after_seconds: 7200, status: "pending" },
    { actor: "admin", trigger_after_seconds: 14400, status: "pending" },
  ];

  it("advances index by 1 and marks previous as promoted, new as active", () => {
    const result = promoteLadder({
      ladder_index: 0,
      assignment_ladder: initialLadder,
      created_at: createdAt,
    });
    expect(result.ladder_index).toBe(1);
    expect(result.ladder[0].status).toBe("promoted");
    expect(result.ladder[1].status).toBe("active");
    expect(result.ladder[2].status).toBe("pending");
    expect(result.previous_assignee).toBe("alice");
    expect(result.new_assignee).toBe("manager");
  });

  it("sets ladder_next_promote_at from created_at + next-step trigger (cumulative)", () => {
    const result = promoteLadder({
      ladder_index: 0,
      assignment_ladder: initialLadder,
      created_at: createdAt,
    });
    const expected = new Date(createdAt.getTime() + 14400 * 1000);
    expect(result.ladder_next_promote_at?.toISOString()).toBe(expected.toISOString());
  });

  it("returns null ladder_next_promote_at after promoting to the final step", () => {
    const afterFirst = promoteLadder({
      ladder_index: 0,
      assignment_ladder: initialLadder,
      created_at: createdAt,
    });
    const result = promoteLadder({
      ladder_index: afterFirst.ladder_index,
      assignment_ladder: afterFirst.ladder,
      created_at: createdAt,
    });
    expect(result.ladder_index).toBe(2);
    expect(result.ladder[0].status).toBe("promoted");
    expect(result.ladder[1].status).toBe("promoted");
    expect(result.ladder[2].status).toBe("active");
    expect(result.ladder_next_promote_at).toBeNull();
    expect(result.new_assignee).toBe("admin");
  });

  it("throws when promoting past the final step", () => {
    const twoStep: AssignmentLadder = [
      { actor: "alice", trigger_after_seconds: 60, status: "promoted" },
      { actor: "bob", trigger_after_seconds: 120, status: "active" },
    ];
    expect(() =>
      promoteLadder({ ladder_index: 1, assignment_ladder: twoStep, created_at: createdAt }),
    ).toThrowError(/past the final ladder step/);
  });

  it("throws when the review has no ladder", () => {
    expect(() =>
      promoteLadder({ ladder_index: 0, assignment_ladder: null, created_at: createdAt }),
    ).toThrowError(/without an assignment_ladder/);
  });

  it("throws on out-of-bounds ladder_index", () => {
    expect(() =>
      promoteLadder({ ladder_index: 99, assignment_ladder: initialLadder, created_at: createdAt }),
    ).toThrowError(/out of bounds/);
  });
});
