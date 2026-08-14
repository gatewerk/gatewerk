/**
 * inline-edit-decide-body.test.ts — the reported bug, end to end at unit
 * level: RailDecision.tsx reads `editedPayload.staged` at click time, which
 * is local React state. If the reviewer's last edit was committed by a blur
 * that fired from the same click (focus leaving the field to land on the
 * Approve button), that commit's state update may not have flushed into the
 * closed-over `staged` value the decision handler already captured.
 *
 * The fix: `useEditedPayload` exposes a ref-backed `getStaged()` that is
 * updated synchronously inside `set`/`revert`/`clear` (not only via the
 * `useState` setter), so a commit triggered a moment earlier in the same
 * synchronous stretch of work is visible immediately — no flushSync, no
 * waiting for React to re-render. RailDecision's decide handler must read
 * `editedPayload.getStaged()`, not the `staged` field, at submit time.
 *
 * This test wires the real hooks together (useInlineEdit + useEditedPayload)
 * and the real mergeEditedPayload, and simulates the blur-from-click
 * ordering: commit the draft via the inline-edit hook's handleBlur, then —
 * in the same tick, without an intervening React render — read the staged
 * map exactly how the decide handler does and build the request body. The
 * commit and the read are both inside a single act() callback on purpose:
 * a flush between them would let `staged` (the reactive field) catch up
 * too, and this test would no longer be able to tell getStaged() apart
 * from the reactive field it exists to replace.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInlineEdit } from "./use-inline-edit";
import { useEditedPayload } from "./use-edited-payload";
import { mergeEditedPayload } from "./decide-body";

describe("inline edit → decide body (unit-level bug repro)", () => {
  it("a field committed via blur-from-click is included in the decide body without an explicit commit", () => {
    const originalPayload = { subject: "Original subject", body: "Original body" };

    const editedPayload = renderHook(() => useEditedPayload()).result;

    const inlineEdit = renderHook(() =>
      useInlineEdit((value) => editedPayload.current.set("subject", value, originalPayload.subject)),
    ).result;

    // Reviewer opens the field and types — no explicit commit yet.
    act(() => inlineEdit.current.startEdit(originalPayload.subject));
    act(() => inlineEdit.current.updateDraft("Edited subject"));

    // Blur-from-click: the click on Approve moves focus off the field,
    // firing blur (and thus the commit) before/without the reviewer ever
    // pressing Cmd+Enter. This is exactly what RailDecision's click handler
    // must see: fire the blur commit, then read staged synchronously in the
    // same synchronous stretch of work, same as a click handler would.
    //
    // Both the commit and the read happen inside ONE act() callback, with no
    // act() boundary (and therefore no React flush) between them — a
    // separate act() per call would let React re-render before the read,
    // which would make `staged` (the reactive useState field) look current
    // too and hide exactly the bug this test exists to catch. Only a
    // ref-backed getStaged() is guaranteed correct here; the reactive field
    // is not.
    let body: Record<string, unknown> | undefined;
    act(() => {
      inlineEdit.current.handleBlur();
      // Decide handler's own line: `mergeEditedPayload(review.payload, editedPayload.getStaged())`.
      body = mergeEditedPayload(originalPayload, editedPayload.current.getStaged());
    });

    expect(body).toEqual({ subject: "Edited subject", body: "Original body" });
  });
});
