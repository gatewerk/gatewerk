/**
 * The regression this pins: web-next stages inline edits in `useEditedPayload`
 * and then never sends them. `ReviewDetail` threads the handle into
 * `PayloadColumn` only, so `RailDecision`'s reviews.decide / reviews.action
 * calls carry no `edited_payload` and a reviewer's edits are silently dropped
 * at the moment of decision. apps/web sends them
 * (apps/web/src/pages/inbox/use-action-feedback-state.ts:76-89); web-next lost
 * it in the rewrite, and web-next is what replaces apps/web at the cutover.
 *
 * The wire value is the FULL merged payload, not a diff — that is what the
 * server persists as the reviewed version — and it is omitted entirely when
 * nothing is staged, so an untouched approval is byte-identical to today's.
 */

import { describe, expect, it } from "vitest";
import { mergeEditedPayload } from "./decide-body";

describe("mergeEditedPayload", () => {
  it("omits edited_payload entirely when nothing is staged", () => {
    expect(mergeEditedPayload({ amount: 180 }, new Map())).toBeUndefined();
  });

  it("merges staged fields over the original payload", () => {
    const staged = new Map<string, unknown>([["amount", 160]]);
    expect(mergeEditedPayload({ amount: 180, customer: "ACME" }, staged)).toEqual({
      amount: 160,
      customer: "ACME",
    });
  });

  it("keeps untouched fields, so the server receives the whole reviewed payload", () => {
    const staged = new Map<string, unknown>([["reason", "duplicate charge"]]);
    expect(
      mergeEditedPayload({ amount: 180, customer: "ACME", reason: "unclear" }, staged),
    ).toEqual({ amount: 180, customer: "ACME", reason: "duplicate charge" });
  });

  it("still sends the staged field when the review carries no payload", () => {
    const staged = new Map<string, unknown>([["amount", 160]]);
    expect(mergeEditedPayload(null, staged)).toEqual({ amount: 160 });
    expect(mergeEditedPayload(undefined, staged)).toEqual({ amount: 160 });
  });

  it("sends a staged null rather than treating it as absent", () => {
    // `null` is a legitimate edited value: clearing a field is an edit. A
    // truthiness check here would drop it and send the original instead, which
    // is the same class of silent loss this helper exists to close.
    const staged = new Map<string, unknown>([["assignee", null]]);
    expect(mergeEditedPayload({ assignee: "dana" }, staged)).toEqual({ assignee: null });
  });
});
