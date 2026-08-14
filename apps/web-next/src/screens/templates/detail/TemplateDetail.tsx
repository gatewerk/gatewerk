/**
 * TemplateDetail — the whole editor for one template.
 *
 * Every rule this screen enforces already exists as a tested, framework-free
 * module in apps/web, and this file imports rather than restates them:
 *
 *   draft-config-state        seed -> edit -> save, and the preservation baseline
 *   publish-flow              the Publish gate and the await ordering
 *   field-options-state       select options, and the array a save actually sends
 *   action-editor-modal-state the four action axes as two controls
 *   chain-editor-state        chain round trip, including the raw-step stash
 *   template-export           the read-only Export projection
 *
 * WHAT IS ON SCREEN IS THE DECLARED SURFACE, NOT apps/web's SCREEN.
 * `packages/shared/src/surface-tiers/templates.ts` declares exactly six control
 * groups for `template-editor`: identity, fields, actions, timeout,
 * external-links, instructions. apps/web additionally renders auto_approve,
 * changes_timeout_hours, allow_monitoring, default_auth_level and
 * default_expiry_seconds, all five of them roadmap tier — S4 rewrote the action
 * modal, the fields tab and the JSON tab but never touched DetailEditConfig.tsx,
 * and `pnpm audit:surface` cannot see it because the gate reads the backend axis
 * inventory and never looks at either frontend. Those five are HIDDEN here, not
 * deleted: they ride through `buildDraftConfig`'s preservation baseline, and
 * draft-config-preservation.test.ts is the gate that proves it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TemplateSchema, ChainDefinition } from "@gatewerk/shared";
import { templates } from "@gatewerk/web-core/api/templates";
import { mapError, showMappedError } from "@gatewerk/web-core/lib/errors";
import { useTemplateStats } from "@gatewerk/web-core/state/templates/detail/use-template-stats";
import { seedEditorState, buildDraftConfig, type EditorState } from "@gatewerk/web-core/state/templates/detail/draft-config-state";
import { canPublishTemplate, hasPublishableChanges, runPublish } from "@gatewerk/web-core/state/templates/detail/publish-flow";
import { TEMPLATES_QUERY_KEY } from "../Templates";
import { DetailHeader } from "./DetailHeader";
import { DetailRail } from "./DetailRail";
import { EditConfig } from "./EditConfig";
import { ReadConfig } from "./ReadConfig";
import { FieldsSection } from "./FieldsSection";
import { ActionsSection } from "./ActionsSection";
import { ChainSection } from "./ChainSection";
import { ExportSection } from "./ExportSection";

/** `TemplateSchema` is a hand-maintained interface with no index signature. */
const asRecord = (t: TemplateSchema): Record<string, unknown> => t as unknown as Record<string, unknown>;

export function TemplateDetail({
  template,
  onRemoved,
}: {
  template: TemplateSchema;
  /** Told when the row should leave the list: delete, or discarding a draft. */
  onRemoved: (id: string, message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(template.status === "draft");
  const [saving, setSaving] = useState(false);

  // One object rather than fifteen setters. The editor renders a subset of
  // EditorState; the rest is seeded, never touched, and written straight back —
  // which is exactly what makes hiding a roadmap axis safe.
  const [state, setState] = useState<EditorState>(() => seedEditorState(asRecord(template)));
  function patch(next: Partial<EditorState>) {
    setState((s) => ({ ...s, ...next }));
  }

  // Slug auto-derives from name until the operator touches it. Only ever true
  // for a draft: after first publish the slug is the identifier integrations
  // call, and execute-action resolves a review's action vocabulary by slug.
  const [autoSlug, setAutoSlug] = useState(() => template.status === "draft" && !state.slug);

  const { data: stats } = useTemplateStats(template.id);

  // The shared gate runs the server's field and action rules. The name check is
  // web-next's addition, and it is not cosmetic: publishing a draft whose name
  // was never typed promotes the placeholder `draft-xxxxxxxx` slug, and the
  // slug is immutable after first publish. One unnoticed click leaves a
  // permanently mis-slugged template that agents then have to call by that
  // name. The server does not refuse it, so the button does.
  const canPublish = useMemo(
    () => state.name.trim().length > 0 && canPublishTemplate(state.fields, state.actions),
    [state.name, state.fields, state.actions],
  );

  // ── autosave ────────────────────────────────────────────────────────────
  // Debounced flush to PATCH /:id/draft. The ready ref skips the first pass
  // after entering edit mode, where state was just seeded from props and no
  // user change has happened yet.
  const autosaveReadyRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the operator has actually changed something this edit session.
  // `template.draft_config` can't carry this alone: it lags the keystrokes by
  // the debounce, and it survives "Done editing" from an earlier session. Set
  // where the autosave decides a change is real; cleared on entering edit mode
  // and on discard.
  const [editedThisSession, setEditedThisSession] = useState(false);
  // The save the debounce is holding, so it can be sent early instead of thrown
  // away, and the promise of the last one sent, so callers can order behind it.
  const pendingSaveRef = useRef<(() => Promise<unknown>) | null>(null);
  const inFlightRef = useRef<Promise<unknown> | null>(null);
  const [autosaveFailed, setAutosaveFailed] = useState(false);

  function sendDraft(body: Record<string, unknown>): Promise<unknown> {
    const p = templates
      .updateDraft(template.id, body)
      .then((r) => {
        setAutosaveFailed(false);
        void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
        return r;
      })
      .catch((e) => {
        // The rail reads this. Swallowing the failure while the rail says
        // "Saving as you type" is the worst of both: the operator keeps typing
        // into a session that is no longer being persisted.
        setAutosaveFailed(true);
        console.warn("[TemplateDetail] autosave failed:", e);
      });
    inFlightRef.current = p;
    return p;
  }

  useEffect(() => {
    if (!isEditing) {
      autosaveReadyRef.current = false;
      return;
    }
    if (!autosaveReadyRef.current) {
      autosaveReadyRef.current = true;
      return;
    }
    setEditedThisSession(true);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    const body = buildDraftConfig(state, asRecord(template));
    const send = () => {
      pendingSaveRef.current = null;
      autosaveTimerRef.current = null;
      return sendDraft(body);
    };
    pendingSaveRef.current = send;
    autosaveTimerRef.current = setTimeout(send, 600);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // `template` and `queryClient` are stable for this mount (the page remounts
    // on identity change). Adding `state`'s object identity is the point — it
    // changes on every edit, which is what restarts the 600ms window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, state]);

  // Send whatever the debounce is holding, and hand back a promise that also
  // covers a save already on the wire. Named for what it does: the old version
  // only cleared the timer, so the last <600ms of typing was discarded on
  // Cancel and on switching rows, which is exactly when an operator believes
  // their work is safe.
  function flushDraft(): Promise<unknown> {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) return pending();
    return inFlightRef.current ?? Promise.resolve();
  }

  /** Drop the debounced save without sending it. Only for paths that discard. */
  function dropPendingDraft(): Promise<unknown> {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
    // A PATCH already on the wire still has to settle first, or DELETE /draft
    // can land before it and the discarded content comes straight back.
    return inFlightRef.current ?? Promise.resolve();
  }

  // ── Escape ──────────────────────────────────────────────────────────────
  // CAPTURE, not bubble. useZen registers a document-BUBBLE listener when the
  // shell mounts, which is before this one, so a bubble listener here would run
  // second and zen would already have collapsed. Capture puts this ahead of it.
  //
  // It does NOT rely on running behind the popover/modal handlers via
  // ordering — it can't. Those also capture on `document`, but they mount
  // only once a field/action modal opens, which is always AFTER this effect
  // already subscribed (you have to already be editing to open one). Multiple
  // capture listeners on the same target fire in REGISTRATION order, so this
  // handler would always run first and cancel the whole edit before the
  // modal's own preventDefault() ever lands — confirmed live: Escape inside
  // FieldModal was closing the modal AND kicking the editor out of edit mode
  // in one keystroke. Checking for an open dialog directly sidesteps the
  // ordering question entirely; both ActionModal and the shared Modal render
  // `role="dialog"` while open.
  //
  // `handleCancel` goes through a ref rather than the dependency array. The
  // effect must not re-subscribe on every render, but the callback closes over
  // `template`, and autosave invalidates the list, so a pinned closure would
  // re-seed the editor from a stale row and the next keystroke would write
  // those stale values back over the server's draft.
  const cancelRef = useRef<() => void>(() => {});
  cancelRef.current = handleCancel;
  useEffect(() => {
    if (!isEditing) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      cancelRef.current();
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isEditing]);

  /**
   * Leave edit mode, keeping the autosaved draft. Only Discard clears it.
   *
   * Flushes rather than cancels: the operator's last keystrokes are the ones
   * most likely to still be inside the debounce window. It does not re-seed
   * from `template` either — that row can be a refetch behind, and snapping the
   * editor back to it was how an in-flight rename got reverted on screen and
   * then written back stale on the next edit. The pane repaints from
   * `template` in read mode anyway once the flush's invalidation lands.
   */
  function handleCancel() {
    void flushDraft();
    setIsEditing(false);
  }

  function handlePublish() {
    const draft = buildDraftConfig(state, asRecord(template));
    // Drop the debounce: this same body is about to be sent synchronously, and
    // letting the timer also fire would race two writes of it.
    void dropPendingDraft();
    return runPublish({
      saveDraft: async () => {
        await inFlightRef.current;
        return templates.updateDraft(template.id, draft);
      },
      // runPublish swallows a publish rejection on the documented premise that
      // the caller already surfaced it. That held in apps/web, which passes a
      // useOptimisticMutation whose onError toasts. `templates.publish` is a
      // bare defineMutation with no error path, so without this the operator
      // gets a stopped spinner and nothing else: no toast, no inline message,
      // no console line. Surface it here, then rethrow so runPublish still
      // keeps edit mode open on the config that was rejected.
      publish: async () => {
        try {
          return await templates.publish(template.id);
        } catch (e) {
          showMappedError(mapError(e));
          throw e;
        }
      },
      setSaving,
      setIsEditing,
      onDraftError: (e) => showMappedError(mapError(e)),
      onPublished: () => {
        toast.success(`Published ${state.name || "template"}`);
        void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      },
    });
  }

  /**
   * Discard means two different things.
   * A draft has no published version to fall back to, so discarding deletes it.
   * A published template reverts to its published columns and clears the draft.
   */
  async function handleDiscard() {
    // Wait for any PATCH already on the wire. Without this the DELETE can win
    // the race, the PATCH lands second, and the content the operator just
    // discarded is recreated under a toast that says it was discarded.
    await dropPendingDraft();
    if (template.status === "draft") {
      try {
        await templates.delete(template.id);
        onRemoved(template.id, "Draft discarded");
      } catch (e) {
        showMappedError(mapError(e));
      }
      return;
    }
    setState(seedEditorState(asRecord(template), { fromDraft: false }));
    setEditedThisSession(false);
    setIsEditing(false);
    try {
      await templates.discardDraft(template.id);
      toast.success("Discarded unpublished changes");
      await queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    } catch (e) {
      showMappedError(mapError(e));
    }
  }

  async function handleDelete() {
    // Drop, not flush: the row is about to cease to exist, so a pending draft
    // save is both pointless and a 404 waiting to happen.
    await dropPendingDraft();
    try {
      await templates.delete(template.id);
      onRemoved(template.id, `Deleted ${template.name || "template"}`);
    } catch (e) {
      showMappedError(mapError(e));
    }
  }

  async function handleStatus(next: "pause" | "resume") {
    try {
      await (next === "pause" ? templates.pause(template.id) : templates.resume(template.id));
      toast.success(next === "pause" ? `Deactivated ${template.name}` : `Activated ${template.name}`);
      await queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    } catch (e) {
      showMappedError(mapError(e));
    }
  }

  const chainConfig = (template.chain_config ?? null) as ChainDefinition | null;

  // Read mode shows what is LIVE, edit mode shows what is being edited. Mixing
  // them made the same pane contradict itself: fields came from the published
  // columns while actions came from editor state, so an action added and then
  // cancelled still appeared in read mode as though reviewers could press it.
  const published = seedEditorState(asRecord(template), { fromDraft: false });
  const shown = isEditing ? state : published;

  const hasChanges = hasPublishableChanges({
    isDraft: template.status === "draft",
    hasPersistedDraft: template.draft_config != null,
    editedThisSession,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DetailHeader
        template={template}
        name={state.name}
        slug={state.slug}
        isEditing={isEditing}
        onDelete={() => void handleDelete()}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── Main column ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-7 px-7 py-6">
            {isEditing ? (
              <EditConfig
                state={state}
                patch={patch}
                slugEditable={template.status === "draft"}
                autoSlug={autoSlug}
                setAutoSlug={setAutoSlug}
              />
            ) : (
              <ReadConfig template={template} state={published} />
            )}

            {/* Fields and actions read as one pair — what the reviewer is
                given, and what the reviewer may do with it — so they sit side
                by side rather than one scrolled past the other.

                auto-fit, not a breakpoint. The pane's width is not a function
                of the viewport: collapsing the template list hands this column
                another 392px, and a media query cannot see that. auto-fit
                splits on the width the column actually has and folds back to
                one column below ~628px, wherever that width came from. */}
            <div
              className="grid items-start gap-7"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}
            >
              <FieldsSection
                isEditing={isEditing}
                fields={shown.fields}
                setFields={(next) => patch({ fields: next })}
                removeField={(i) => patch({ fields: state.fields.filter((_, x) => x !== i) })}
              />

              <ActionsSection
                isEditing={isEditing}
                actions={shown.actions}
                setActions={(actions) => patch({ actions })}
              />
            </div>

            <ChainSection
              templateId={template.id}
              chainConfig={chainConfig}
              disabledReason={
                template.status === "draft"
                  ? {
                      title: "Chains start when a review is created against a published template.",
                      hint: "Publish this template to add one.",
                    }
                  : null
              }
              onSaved={() => void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY })}
            />

            <ExportSection template={template} />
          </div>
        </div>

        {/* ── Right rail ── */}
        <DetailRail
          template={template}
          state={shown}
          stats={stats}
          isEditing={isEditing}
          saving={saving}
          canPublish={canPublish}
          hasChanges={hasChanges}
          autosaveFailed={autosaveFailed}
          onPublish={() => void handlePublish()}
          onDiscard={() => void handleDiscard()}
          onCancel={handleCancel}
          onEdit={() => {
            setEditedThisSession(false);
            setIsEditing(true);
          }}
          onPause={() => void handleStatus("pause")}
          onResume={() => void handleStatus("resume")}
        />
      </div>
    </div>
  );
}
