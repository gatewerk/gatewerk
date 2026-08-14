import { describe, it, expect } from "vitest";
import type { TemplateField, TemplateActionConfigCanonical } from "@gatewerk/shared";
import { canPublishTemplate, hasPublishableChanges, runPublish, type PublishFlowDeps } from "./publish-flow";
import { collectValidation } from "./action-editor-state";

// S4 defect 2, both halves.
//
// (a) The Publish button read `collectValidation(actions)` only, so a field
//     problem was invisible client side and arrived as a server 422.
// (b) `handlePublish` left edit mode BEFORE awaiting the two network calls, so
//     the pane repainted from the published columns — for a fresh draft that
//     is `fields: []` and the name "Untitled template" — and the 422 toast
//     landed afterwards naming a field the operator could no longer see.
//     Nothing restored edit mode.

function decision(id: string, decision_value: "approved" | "rejected"): TemplateActionConfigCanonical {
  return { id, label: id, kind: "decision", decision_value, style: "primary" };
}

const validActions = [decision("approve", "approved"), decision("reject", "rejected")];

function textField(name: string): TemplateField {
  return { name, type: "text", label: name };
}

// Records every dependency call in order so the test can assert WHEN edit mode
// closes, not merely that it eventually did.
function recorder() {
  const log: string[] = [];
  const deps = (over: Partial<PublishFlowDeps> = {}): PublishFlowDeps => ({
    saveDraft: async () => { log.push("saveDraft"); },
    publish: async () => { log.push("publish"); },
    setSaving: (v) => log.push(`setSaving:${v}`),
    setIsEditing: (v) => log.push(`setIsEditing:${v}`),
    onDraftError: () => log.push("onDraftError"),
    onPublished: () => log.push("onPublished"),
    ...over,
  });
  return { log, deps };
}

describe("canPublishTemplate", () => {
  it("blocks a select field with no options", () => {
    const fields: TemplateField[] = [{ name: "tier", type: "select", label: "Tier" }];

    // The old gate read actions alone, and these actions are valid — which is
    // exactly why the operator reached the server and got a 422.
    expect(collectValidation(validActions)).toEqual([]);

    expect(canPublishTemplate(fields, validActions)).toBe(false);
  });

  it("blocks a template with no fields at all", () => {
    expect(canPublishTemplate([], validActions)).toBe(false);
  });

  it("blocks duplicate field names", () => {
    expect(canPublishTemplate([textField("amount"), textField("amount")], validActions)).toBe(false);
  });

  it("ignores a freshly added unnamed row, which the save drops anyway", () => {
    const fields: TemplateField[] = [textField("amount"), { name: "", type: "text", label: "" }];
    expect(canPublishTemplate(fields, validActions)).toBe(true);
  });

  it("still blocks on the action rules", () => {
    expect(canPublishTemplate([textField("amount")], [])).toBe(false);
  });

  it("allows a valid template", () => {
    const fields: TemplateField[] = [
      textField("amount"),
      { name: "tier", type: "select", label: "Tier", options: ["gold"] },
    ];
    expect(canPublishTemplate(fields, validActions)).toBe(true);
  });
});

describe("runPublish", () => {
  it("does not leave edit mode until both round trips have resolved", async () => {
    const { log, deps } = recorder();

    const published = await runPublish(deps());

    expect(published).toBe(true);
    expect(log).toEqual([
      "setSaving:true",
      "saveDraft",
      "publish",
      "setIsEditing:false",
      "setSaving:false",
      "onPublished",
    ]);
  });

  it("stays in edit mode when the draft flush fails", async () => {
    const { log, deps } = recorder();

    const published = await runPublish(deps({
      saveDraft: async () => { log.push("saveDraft"); throw new Error("network"); },
    }));

    expect(published).toBe(false);
    expect(log).not.toContain("setIsEditing:false");
    expect(log).not.toContain("publish");
    expect(log).toEqual(["setSaving:true", "saveDraft", "onDraftError", "setSaving:false"]);
  });

  it("stays in edit mode when publish 422s, so the operator can fix the field", async () => {
    const { log, deps } = recorder();

    const published = await runPublish(deps({
      publish: async () => { log.push("publish"); throw new Error("422"); },
    }));

    expect(published).toBe(false);
    expect(log).not.toContain("setIsEditing:false");
    expect(log).not.toContain("onPublished");
    expect(log).toEqual(["setSaving:true", "saveDraft", "publish", "setSaving:false"]);
  });

  it("holds edit mode open while the publish call is still in flight", async () => {
    const { log, deps } = recorder();
    let releasePublish!: () => void;
    const inFlight = new Promise<void>((resolve) => { releasePublish = resolve; });

    const pending = runPublish(deps({
      publish: async () => { log.push("publish"); await inFlight; },
    }));

    // Let saveDraft settle and publish start, then check mid-flight state.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toContain("publish");
    expect(log).not.toContain("setIsEditing:false");

    releasePublish();
    await pending;
    expect(log).toContain("setIsEditing:false");
  });
});

describe("hasPublishableChanges", () => {
  // The bug this gate closes: a published template opened in edit mode showed
  // an enabled "Publish changes" before anything diverged — clicking it either
  // republished identical content or hit the server's `no_draft` 400.

  it("always allows a draft: first publish is the template's birth", () => {
    expect(hasPublishableChanges({ isDraft: true, hasPersistedDraft: false, editedThisSession: false })).toBe(true);
  });

  it("blocks a published template with no divergence", () => {
    expect(hasPublishableChanges({ isDraft: false, hasPersistedDraft: false, editedThisSession: false })).toBe(false);
  });

  it("allows when a draft_config persists from an earlier session", () => {
    expect(hasPublishableChanges({ isDraft: false, hasPersistedDraft: true, editedThisSession: false })).toBe(true);
  });

  it("allows during the autosave debounce window, before the draft persists", () => {
    // The operator's edit exists only in editor state for up to 600ms. A gate
    // reading draft_config alone would block a publish of real changes here.
    expect(hasPublishableChanges({ isDraft: false, hasPersistedDraft: false, editedThisSession: true })).toBe(true);
  });
});
