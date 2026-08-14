/**
 * The reviewer walkthrough's sample review.
 *
 * Nothing here is real and nothing here may reach the server. That is the
 * handoff's one hard rule for this surface, and it is not a nicety: the thing
 * being taught is that a decision is final and the agent acts the instant you
 * approve. A practice run that could fire a real decision would be teaching the
 * lesson by breaking it.
 *
 * The sentinel id is namespaced with a colon so it cannot collide with a real
 * review id, which is a prefixed ULID. Nothing client-side validates id format —
 * every path template runs it through encodeURIComponent — so the id alone
 * guarantees nothing. `isSampleReview` is the guard, and its call sites are what
 * make the rule true: the walkthrough's own buttons never call the reviews API,
 * and the two components that fire ungated queries on render (ActivityThread,
 * RailNotes) check it before fetching.
 */

import type { Review } from "@gatewerk/web-core/api/reviews";

export const SAMPLE_REVIEW_ID = "sample:onboarding";

export function isSampleReview(id: string | null | undefined): boolean {
  return id === SAMPLE_REVIEW_ID;
}

/** The original amount, kept here so the walkthrough can tell "edited" from "reverted". */
export const SAMPLE_ORIGINAL_AMOUNT = 180;

/**
 * A Review-shaped fixture. `template_fields` rather than a full template embed:
 * resolveFields accepts the snapshot form, and it is the smaller surface to
 * keep honest.
 *
 * Exactly one field is editable. That is the whole lesson — a reviewer learns
 * that the agent's proposal is theirs to change — and a fixture where
 * everything is editable teaches the opposite of what production does.
 */
export function buildSampleReview(): Review {
  const now = new Date(0).toISOString();
  return {
    id: SAMPLE_REVIEW_ID,
    project_id: SAMPLE_REVIEW_ID,
    template_id: null,
    template_slug: "refund-approval",
    payload: {
      customer: "ACME Corp · account #TEST",
      amount: SAMPLE_ORIGINAL_AMOUNT,
      reason:
        "Sample duplicate charge case. Change the amount above, or approve or reject it as it stands.",
    },
    template_fields: [
      { name: "customer", type: "text", label: "customer", readonly: true },
      { name: "amount", type: "number", label: "amount", editable: true },
      { name: "reason", type: "text", label: "reason", readonly: true },
    ],
    priority: "normal",
    status: "pending",
    decision: null,
    edited_payload: null,
    feedback: null,
    decided_by: null,
    decided_at: null,
    current_version: 1,
    assignee: null,
    // Null on purpose: ChainStepper returns before querying when there is no
    // chain run, and RailReviewLink renders nothing without an active token.
    // Both would otherwise reach the network from a fixture.
    chain_run_id: null,
    active_token: null,
    created_at: now,
    updated_at: now,
    template: null,
  } as Review;
}
