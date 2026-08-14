import { describe, it, expect } from "vitest";
import { getNextItemId, getIdAfterDecision } from "./inbox-navigation-logic";

describe("getNextItemId", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns the id after the current one", () => {
    expect(getNextItemId(items, "a")).toBe("b");
    expect(getNextItemId(items, "b")).toBe("c");
  });

  it("returns null when the current item is the last one (no wraparound)", () => {
    expect(getNextItemId(items, "c")).toBeNull();
  });

  it("returns null when currentId is null", () => {
    expect(getNextItemId(items, null)).toBeNull();
  });

  it("returns null when currentId isn't found in items", () => {
    expect(getNextItemId(items, "not-here")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(getNextItemId([], "a")).toBeNull();
  });
});

describe("getIdAfterDecision", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves to the next review in the queue", () => {
    expect(getIdAfterDecision(items, "a")).toBe("b");
    expect(getIdAfterDecision(items, "b")).toBe("c");
  });

  it("falls back to the previous one when the decided review was last", () => {
    expect(getIdAfterDecision(items, "c")).toBe("b");
  });

  it("returns null when the decided review was the only one left", () => {
    expect(getIdAfterDecision([{ id: "a" }], "a")).toBeNull();
  });

  it("returns null rather than guessing when the decided id has already left the list", () => {
    expect(getIdAfterDecision(items, "gone")).toBeNull();
    expect(getIdAfterDecision([], "a")).toBeNull();
    expect(getIdAfterDecision(items, null)).toBeNull();
  });
});
