import { describe, expect, it } from "vitest";
import { priorityBucket } from "./priority-toggle";

describe("priorityBucket", () => {
  it("buckets low into normal", () => {
    expect(priorityBucket("low")).toBe("normal");
  });

  it("keeps normal as normal", () => {
    expect(priorityBucket("normal")).toBe("normal");
  });

  it("keeps high as high", () => {
    expect(priorityBucket("high")).toBe("high");
  });

  it("buckets critical into high", () => {
    expect(priorityBucket("critical")).toBe("high");
  });
});
