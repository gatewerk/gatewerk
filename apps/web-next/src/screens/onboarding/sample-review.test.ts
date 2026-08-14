/**
 * The handoff's hard rule for the reviewer walkthrough: "it must never call
 * reviews.decide". A rule that only exists in prose is a rule that gets ported
 * away, so it is asserted here — structurally, against the source, because
 * web-next has no React render harness and a behavioural test would be hollow.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SAMPLE_REVIEW_ID,
  SAMPLE_ORIGINAL_AMOUNT,
  buildSampleReview,
  isSampleReview,
} from "./sample-review";
import { resolveFields } from "~/screens/inbox/detail/payload-fields";

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8");
}

describe("sample review sentinel", () => {
  it("is namespaced so it cannot collide with a real review id", () => {
    expect(SAMPLE_REVIEW_ID).toBe("sample:onboarding");
    expect(isSampleReview(SAMPLE_REVIEW_ID)).toBe(true);
    expect(isSampleReview("rev_01J8Z9F0000000000000000000")).toBe(false);
    expect(isSampleReview(null)).toBe(false);
    expect(isSampleReview(undefined)).toBe(false);
  });
});

describe("sample review fixture", () => {
  it("marks exactly one field editable, or the walkthrough teaches nothing", () => {
    const editable = resolveFields(buildSampleReview())
      .filter((f) => f.editable)
      .map((f) => f.name);
    expect(editable).toEqual(["amount"]);
  });

  it("renders its fields in payload order through the real resolver", () => {
    expect(resolveFields(buildSampleReview()).map((f) => f.name)).toEqual([
      "customer",
      "amount",
      "reason",
    ]);
  });

  it("keeps the editable field a number, so the real NumberField drives the lesson", () => {
    const amount = resolveFields(buildSampleReview()).find((f) => f.name === "amount");
    expect(amount?.type).toBe("number");
    expect(amount?.value).toBe(SAMPLE_ORIGINAL_AMOUNT);
  });

  it("carries no chain run and no active token, so no descendant reaches the network", () => {
    // ChainStepper returns before querying without a chain_run_id, and
    // RailReviewLink renders nothing without an active_token. Both would
    // otherwise fetch against a fixture id on render.
    const sample = buildSampleReview();
    expect(sample.chain_run_id).toBeNull();
    expect(sample.active_token).toBeNull();
  });
});

describe("the sample never reaches the server", () => {
  it("the walkthrough does not import the reviews API at all", () => {
    const src = source("./SampleWalkthrough.tsx");
    expect(src).not.toMatch(/reviews\.(decide|action|confirm|veto)\b/);
    expect(src).not.toMatch(/@gatewerk\/web-core\/api\/reviews/);
  });

  it("gates both queries that would otherwise fetch on render", () => {
    // ActivityThread's notes and versions queries fire with no `enabled` guard
    // tied to the review being real, so without these the walkthrough would hit
    // the API on render even though its buttons never do. RailNotes inherits
    // the notes gate through the shared attachedNotesQuery, which is why the
    // guard lives in the helper rather than at each call site.
    const src = source("../inbox/detail/ActivityThread.tsx");
    const gates = src.match(/enabled: !isSampleReview\(reviewId\)/g) ?? [];
    expect(gates).toHaveLength(2);
    expect(source("../inbox/detail/rail/RailNotes.tsx")).toMatch(/attachedNotesQuery/);
  });
});
