/**
 * Chain — a SECTION of the template editor, not a front door.
 *
 * C1 (charter §4) settled what this screen is: a route of approvers over the
 * template it sits on. One request, one payload, several named humans in order.
 * Per step there are exactly two choices, WHO and GUIDANCE, plus reorder and
 * remove, which are arrangement rather than configuration. At route level there
 * are none at all: a first step enables the route, an empty list disables it.
 *
 * Three sentences sit under the list. They are
 * displayed truths, not choices — each is a property of the engine that an
 * author has no way to change, and an author who cannot see them has to
 * discover them by being surprised: the order, rejection semantics, and the
 * webhook event contract chained reviews use instead of review.decided.
 *
 * A fourth, about monitoring being refused while a chain is configured, was
 * added and pulled the same day. See the comment where it used to sit.
 *
 * No `/chains` route, no nav item, no named destination: `surface: 'chain-builder'`
 * denotes a screen REGION (surface-tiers/chains.ts). This is the piece web-next
 * was missing outright, which mattered because web-next takes the primary
 * origin — without it, chain configuration disappears from the product.
 *
 * Drafts see the section DISABLED, not hidden. Chains spawn on POST /reviews
 * against a published template, so a draft cannot accept one yet; hiding it
 * would mean an author who builds as a draft never learns chains exist.
 *
 * The whole round trip is `chain-editor-state`, including `_stepRaw` and
 * `_externalTokenRaw` — the two stashes that carry every axis with no control
 * (timeout_seconds, depends_on, metadata, parallel_group, condition, and the
 * full external-token spec) through an edit. Spread order there is load
 * bearing; the preservation test is the gate.
 *
 * Step creation and editing an existing step both go through ChainStepModal
 * now, matching FieldsSection/ActionsSection's add/edit-via-modal shape
 * (`{kind:"closed"}|{kind:"add"}|{kind:"edit",index}`). Reorder and remove
 * stay here, as icon buttons on the row — arrangement, not configuration,
 * per this file's own line above. The modal only ever patches the fields it
 * renders (WHO, GUIDANCE, and the Advanced ID/Priority pair); every other
 * WorkingStep field, including the two raw stashes, rides through on the
 * `form` object untouched, so the preservation test never sees this move.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Pencil, Plus, X } from "lucide-react";
import type { ChainDefinition } from "@gatewerk/shared";
import { templates } from "@gatewerk/web-core/api/templates";
import { ApiError } from "@gatewerk/web-core/api/client/http";
import { mapError, showMappedError } from "@gatewerk/web-core/lib/errors";
import { toast } from "sonner";
import {
  MAX_STEPS,
  applyStepPatch,
  buildChainConfig,
  describeHiddenStepAxes,
  mapServerErrors,
  moveStep,
  nameToId,
  seedSteps,
  type ValidationErrors,
  type WorkingStep,
} from "@gatewerk/web-core/state/templates/detail/chain-editor-state";
import { ChainStepModal } from "./ChainStepModal";
import { AddLink, CARD_STYLE, EmptyState, GhostButton, PrimaryButton, SectionHeader } from "../_ui";

type ModalState = { kind: "closed" } | { kind: "add" } | { kind: "edit"; index: number };

interface Props {
  templateId: string;
  chainConfig: ChainDefinition | null;
  /** Set for drafts. Non-null renders the section read only with the reason. */
  /** Two strings, because the slot draws a title over a hint. */
  disabledReason: { title: string; hint: string } | null;
  onSaved: () => void;
}

export function ChainSection({ templateId, chainConfig, disabledReason, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState<WorkingStep[]>(() => seedSteps(chainConfig));
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const persistedSteps = chainConfig?.steps ?? [];
  const disabled = disabledReason != null;

  function beginEdit(withBlank: boolean) {
    const seeded = seedSteps(chainConfig);
    setSteps(seeded);
    setErrors({});
    setEditing(true);
    // "Add chain" on an empty route used to seed one blank inline card ready
    // for input. Typing now happens in the modal, so it opens straight to
    // add-step instead.
    setModal(withBlank && seeded.length === 0 ? { kind: "add" } : { kind: "closed" });
  }

  function cancel() {
    setSteps(seedSteps(chainConfig));
    setErrors({});
    setEditing(false);
    setModal({ kind: "closed" });
  }

  function submitStepModal(step: WorkingStep) {
    if (modal.kind === "add") {
      setSteps((s) => [...s, step]);
    } else if (modal.kind === "edit") {
      const index = modal.index;
      setSteps((s) => s.map((existing, i) => (i === index ? step : existing)));
    }
  }

  async function save() {
    const { config, errors: built } = buildChainConfig(steps);
    if (Object.keys(built).length > 0) {
      setErrors(built);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await templates.update(templateId, { chain_config: config });
      toast.success(config ? "Chain saved" : "Chain removed");
      setEditing(false);
      onSaved();
    } catch (e) {
      // A 422 from the chain schema carries per-step paths. Rendering them on
      // the row that caused them beats a toast naming `steps.1.assignee.email`.
      if (e instanceof ApiError && Array.isArray(e.details)) {
        const mapped = mapServerErrors(e.details as { path: string | (string | number)[]; message: string }[]);
        if (Object.keys(mapped).length > 0) {
          setErrors(mapped);
          setSaving(false);
          return;
        }
      }
      showMappedError(mapError(e));
    } finally {
      setSaving(false);
    }
  }

  const stepCount = editing ? steps.length : persistedSteps.length;
  // Read from whichever list is on screen. A persisted step with no policy is
  // the default: the engine's dispatcher maps NULL to abort.
  const allStepsAbortOnReject = editing
    ? steps.every((s) => s.rejectionPolicy === "abort")
    : persistedSteps.every((s) => !s.rejection_policy || s.rejection_policy === "abort");
  const countLabel = stepCount > 0 ? `${stepCount} ${stepCount === 1 ? "step" : "steps"}` : "";

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        label="Chain"
        right={
          <div className="flex shrink-0 items-center gap-3">
            {countLabel && (
              <span className="font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
                {countLabel}
              </span>
            )}
            {!editing && !disabled && (
              <AddLink onClick={() => beginEdit(persistedSteps.length === 0)}>
                {persistedSteps.length === 0 ? (
                  <>
                    <Plus size={12} strokeWidth={2.2} />
                    Add chain
                  </>
                ) : (
                  "Edit chain"
                )}
              </AddLink>
            )}
          </div>
        }
      />

      {/* Same slot, same shape as the empty state it stands in for. A draft
          has no chain for a reason rather than by omission, and that is a
          difference in what the words say, not in whether they get a box. */}
      {disabled && disabledReason && (
        <EmptyState title={disabledReason.title} hint={disabledReason.hint} />
      )}

      {!disabled && !editing && persistedSteps.length === 0 && (
        <EmptyState title="No chain configured" hint="Reviews against this template run as a single step." />
      )}

      {!disabled && !editing && persistedSteps.length > 0 && (
        <div className="flex flex-col gap-3">
          {persistedSteps.map((step, i) => {
            const assignee = step.assignee;
            const who =
              assignee.kind === "role"
                ? `Role ${assignee.role}`
                : assignee.kind === "user"
                  ? (assignee.email ?? "Unassigned")
                  : "External recipient";
            // Same detection and copy as the editing row (below) and the step
            // modal (ChainStepModal.tsx) — chain-editor-state.ts's
            // describeHiddenStepAxes, fed the persisted wire step directly
            // rather than a WorkingStep's `_stepRaw`, since a persisted step
            // IS what `_stepRaw` is a copy of. Without this, a step carrying a
            // timeout or a condition rendered identically to a plain one until
            // an author happened to open Edit.
            const hiddenAxes = describeHiddenStepAxes(step as unknown as Record<string, unknown>);
            return (
              <div key={step.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-3 rounded-[11px] px-4 py-3" style={CARD_STYLE}>
                  <span
                    className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold"
                    style={{
                      background: "rgba(var(--gw-blue-rgb),.14)",
                      border: "1px solid rgba(var(--gw-blue-rgb),.28)",
                      color: "var(--gw-blue-t)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--gw-t2)" }}>
                    {step.name || step.id}
                  </span>
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--gw-blue-t)" }}>
                    {who}
                  </span>
                </div>
                {/* Quieter than the editing row's identical hint (t8, below):
                    this surface has no per-row secondary text of its own to
                    match, so this borrows the route-level hints' weight
                    instead (t7, e.g. the "Steps run in order" line further
                    down this file) rather than the editor's louder t8. */}
                {hiddenAxes && (
                  <span className="pl-1 text-[11px]" style={{ color: "var(--gw-t7)" }}>
                    Also set over the API: {hiddenAxes}.
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Stated once for the route, not repeated on every card. A card speaks
          up only where its own behaviour DEPARTS from these lines.
          
          The second sentence is conditional, and has to be: the editor cannot
          SET a rejection policy but the API can, and a route carrying an
          API-set `continue` or `branch` step does not stop on a rejection. A
          hint that is false about the very screen it sits on is worse than no
          hint, so when any step departs, the route says so instead of
          asserting the default. */}
      {!disabled && stepCount > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
            Steps run in order. Each one opens when the step before it is approved.
          </span>
          {allStepsAbortOnReject ? (
            <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
              A rejection stops the chain. Later steps never open.
            </span>
          ) : (
            <span className="text-[11px]" style={{ color: "var(--gw-amber-t)" }}>
              A rejection stops the chain, except where a step was set over the API to
              continue or to branch back. Those steps say so.
            </span>
          )}
          {/* Copy verified against docs/protocol/hrp-v1.md's
              Chain Outcomes section (since v1.7) before shipping: a chain
              step's review is never delivered as review.decided, so an
              automation that listens for it silently stops firing the moment
              a template gains a second step. */}
          <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
            Chained templates send different events. Each step sends chain.step_decided, and the
            finished route sends chain.completed. They never send review.decided, so update
            anything listening for it.
          </span>
          {/* NOT SAID HERE, deliberately: that a monitoring request is refused
              while a chain is configured.

              It is true — monitoring-gate.ts:32 checks tpl.chain_config before
              allow_monitoring, so the refusal holds regardless of the flag —
              and it was shown here briefly, then removed.

              Monitoring is declared `tier: "roadmap"` with `built: true` in
              surface-tiers/templates.ts, carrying the ruling that monitoring
              gates ship AFTER launch and are named on the public roadmap. So a
              launch reader of this screen cannot turn monitoring on, and
              telling them it is refused explains a conflict between two things
              they do not have. True, but noise, and it advertises a held
              feature on the wrong surface.

              Put it back when monitoring ships, next to the control that
              enables it, where it stops being trivia and starts being a
              warning someone can act on. */}
        </div>
      )}

      {!disabled && editing && (
        <div className="flex flex-col gap-3">
          {steps.map((step, i) => {
            const who =
              step.assigneeMode === "role"
                ? `Role ${step.assigneeRole}`
                : step.assigneeMode === "external_token"
                  ? "External recipient"
                  : step.assigneeEmail || "Unassigned";
            // Same "<rowIndex>.<field>" keys ChainStepCard used to read
            // directly — the row that used to hold the field now holds the
            // message instead, so a failed save still points at the step.
            const rowError =
              errors[`${i}.assigneeEmail`] ?? errors[`${i}.stepId`] ?? errors[`${i}.rejectionBranchTo`] ?? errors[`${i}._row`];
            // Same fact ChainStepModal shows once a step is open, surfaced
            // here too so it does not take clicking Edit on every row to
            // learn a step carries something this editor cannot show.
            const hiddenAxes = describeHiddenStepAxes(step._stepRaw);
            return (
              <div key={step.rowKey} className="flex flex-col gap-1">
                <div className="flex items-center gap-3 rounded-[11px] px-4 py-3" style={CARD_STYLE}>
                  <span
                    className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold"
                    style={{
                      background: "rgba(var(--gw-blue-rgb),.14)",
                      border: "1px solid rgba(var(--gw-blue-rgb),.28)",
                      color: "var(--gw-blue-t)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <input
                    value={step.stepName}
                    onChange={(e) => {
                      const stepName = e.target.value;
                      // ID follows the name until the operator edits it
                      // directly inside the modal's Advanced disclosure.
                      setSteps((s) =>
                        applyStepPatch(s, i, step.idManuallyEdited ? { stepName } : { stepName, stepId: nameToId(stepName) }),
                      );
                    }}
                    placeholder={`Step ${i + 1} name`}
                    aria-label={`Step ${i + 1} name`}
                    className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-semibold outline-none placeholder:text-t10"
                    style={{ color: "var(--gw-t2)", fontFamily: "inherit" }}
                  />
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--gw-blue-t)" }}>
                    {who}
                  </span>
                  <button
                    type="button"
                    title="Edit step"
                    aria-label={`Edit step ${i + 1}`}
                    onClick={() => setModal({ kind: "edit", index: i })}
                    className="gw-focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-t8 transition-colors hover:text-t4"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title="Move step up"
                    aria-label={`Move step ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => setSteps((s) => moveStep(s, i, i - 1))}
                    className="gw-focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-t8 transition-colors hover:text-t4 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    title="Move step down"
                    aria-label={`Move step ${i + 1} down`}
                    disabled={i === steps.length - 1}
                    onClick={() => setSteps((s) => moveStep(s, i, i + 1))}
                    className="gw-focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-t8 transition-colors hover:text-t4 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    title="Remove step"
                    aria-label={`Remove step ${i + 1}`}
                    onClick={() => setSteps((s) => s.filter((_, x) => x !== i))}
                    className="gw-focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.1)]"
                  >
                    <X size={12} />
                  </button>
                </div>
                {rowError && (
                  <span className="pl-1 text-[11px]" style={{ color: "var(--gw-red-t)" }} role="alert">
                    {rowError}
                  </span>
                )}
                {!rowError && hiddenAxes && (
                  <span className="pl-1 text-[11px]" style={{ color: "var(--gw-t8)" }}>
                    Also set over the API: {hiddenAxes}.
                  </span>
                )}
              </div>
            );
          })}

          {steps.length === 0 && (
            <EmptyState title="No chain configured" hint="Saving now removes the chain. Reviews run as a single step." />
          )}

          <div className="flex items-center gap-3">
            <AddLink onClick={() => setModal({ kind: "add" })} disabled={steps.length >= MAX_STEPS}>
              <Plus size={12} strokeWidth={2.2} />
              Add step
            </AddLink>
            {steps.length >= MAX_STEPS && (
              <span className="text-[11px]" style={{ color: "var(--gw-t8)" }}>
                Maximum {MAX_STEPS} steps
              </span>
            )}
            <span className="flex-1" />
            <GhostButton onClick={cancel} disabled={saving}>
              Cancel
            </GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : steps.length === 0 ? "Remove chain" : "Save chain"}
            </PrimaryButton>
          </div>
        </div>
      )}

      {modal.kind !== "closed" && (
        <ChainStepModal
          initial={modal.kind === "edit" ? steps[modal.index] : undefined}
          errors={errors}
          rowIndex={modal.kind === "edit" ? modal.index : steps.length}
          onClose={() => setModal({ kind: "closed" })}
          onSubmit={submitStepModal}
        />
      )}
    </section>
  );
}
