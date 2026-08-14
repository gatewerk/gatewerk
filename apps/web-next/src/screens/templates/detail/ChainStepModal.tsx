/**
 * Add or edit one chain step's WHO and GUIDANCE — the two things a step
 * configures (ChainSection.tsx's header, C1 charter §4). Mirrors FieldModal's
 * shape: Modal chrome, a vertical label-above-field layout, Cancel/Submit
 * footer (FieldModal.tsx lines 55-56 the title+subtitle block, 68-101 the
 * label-above-input rows, 164-167 the footer).
 *
 * Reorder, remove, and the step's display name are arrangement rather than
 * configuration (ChainStepCard's former header comment, now folded into
 * ChainSection.tsx's) and stay in ChainSection's list row — this modal never
 * renders them.
 *
 * `form` starts as a full copy of `initial` (or a fresh `blankStep()` when
 * adding) and every field this modal renders no input for — rowKey, stepName,
 * assigneeMode, assigneeRole, rejectionPolicy, rejectionBranchTo,
 * _externalTokenRaw, _userRaw, _stepRaw, _definitionRaw — rides through
 * untouched to onSubmit. That is what keeps draft-config-preservation.test.ts
 * green: this file never re-derives the wire shape, it only patches the two
 * fields it renders plus the Advanced (ID, Priority) pair, exactly as
 * ChainStepCard's body used to.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Priority } from "@gatewerk/shared";
import { listTeam } from "@gatewerk/web-core/api/notifications";
import {
  blankStep,
  describeHiddenStepAxes,
  type ValidationErrors,
  type WorkingStep,
} from "@gatewerk/web-core/state/templates/detail/chain-editor-state";
import { Modal } from "~/components/Modal";
import { AutoGrowTextarea } from "~/components/AutoGrowTextarea";
import { activeMembers } from "~/screens/settings/team/team-logic";
import { GhostButton, INSET_INPUT_CLASS, INSET_STYLE, INSET_TEXTAREA_CLASS, PrimaryButton, RowLabel, SelectMenu } from "../_ui";

const PRIORITY_OPTIONS = [
  { value: "", label: "Inherit" },
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

// Verbatim from the retired ChainStepCard.tsx (ROLE_OPTIONS/roleLabel).
const ROLE_OPTIONS = [
  { value: "reviewer", label: "Reviewer" },
  { value: "admin", label: "Admin" },
];
function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
}

interface Props {
  /** undefined = add mode, matching FieldModal's own convention. */
  initial?: WorkingStep;
  errors: ValidationErrors;
  /** The row this step occupies (or will occupy, for add) — used only to key
   * into `errors`, the same "<rowIndex>.<field>" scheme ChainStepCard used. */
  rowIndex: number;
  onClose: () => void;
  onSubmit: (step: WorkingStep) => void;
}

export function ChainStepModal({ initial, errors, rowIndex, onClose, onSubmit }: Props) {
  const isEdit = initial !== undefined;
  const [form, setForm] = useState<WorkingStep>(() => initial ?? blankStep());
  const [advancedOpen, setAdvancedOpen] = useState(!!errors[`${rowIndex}.stepId`]);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const isExternal = form.assigneeMode === "external_token";
  const isRoleAssigned = form.assigneeMode === "role";
  const hiddenAxes = describeHiddenStepAxes(form._stepRaw);

  const err = (field: string) => errors[`${rowIndex}.${field}`];

  // Reuses TeamPane's query and cache key (["settings","team"]) rather than a
  // second fetch — see listTeam in @gatewerk/web-core/api/notifications,
  // consumed the same way in TeamPane.tsx.
  const teamQuery = useQuery(listTeam({}));
  const members = activeMembers(teamQuery.data?.items ?? []);

  function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  function submit() {
    if (form.assigneeMode === "user") {
      const email = normalizeEmail(form.assigneeEmail);
      // A query still in flight (or one that failed) says nothing about
      // whether this address is a member — do not turn "we do not know yet"
      // into "refused". The guard only fires once the roster has actually
      // loaded.
      if (email && !teamQuery.isLoading && !teamQuery.isError) {
        const isMember = members.some((m) => normalizeEmail(m.email) === email);
        if (!isMember) {
          setMembershipError(
            "This address is not a member of your team yet. Invite them from Settings, Team, then add this step.",
          );
          return;
        }
      }
    }
    setMembershipError(null);
    onSubmit(form);
    onClose();
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={isEdit ? "Edit step" : "Add step"}
      title={isEdit ? "Edit step" : "Add step"}
      subtitle="Who reviews this step, and what they should weigh."
      width={420}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Who
        </span>
        {isExternal ? (
          <>
            <span className="text-[12px]" style={{ color: "var(--gw-t5)" }}>
              External recipient
            </span>
            <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
              Set over the API, and left exactly as it is. External recipients on a chain step are
              not configurable here yet.
            </span>
          </>
        ) : isRoleAssigned ? (
          <>
            <span className="text-[12px]" style={{ color: "var(--gw-t5)" }}>
              Role: {roleLabel(form.assigneeRole)}
            </span>
            <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
              Set over the API, and left exactly as it is. Role assignment is not configurable
              here yet.
            </span>
          </>
        ) : (
          <>
            {/* Clicking this field visibly
                "shook" — traced to Proton Pass injecting an autofill badge
                inside the input on focus, which changes the field's content
                box and shifts surrounding layout. This is not our
                positioning (a clean profile with no password-manager
                extension shows zero movement) and there is nothing to fix in
                our layout. The attributes below are the standard opt-out set
                the major password managers respect for a non-credential
                field — a request to skip this field, not a guarantee the
                extension honors it or that any given manager's UI never
                appears here. */}
            <input
              value={form.assigneeEmail}
              onChange={(e) => {
                setMembershipError(null);
                setForm((f) => ({ ...f, assigneeEmail: e.target.value }));
              }}
              placeholder="reviewer@example.com"
              aria-label="Reviewer email"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              data-protonpass-ignore
              className={`${INSET_INPUT_CLASS} w-full`}
              style={INSET_STYLE}
            />
            {(membershipError || err("assigneeEmail")) && (
              <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }} role="alert">
                {membershipError || err("assigneeEmail")}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="chain-step-guidance" className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Guidance
        </label>
        <AutoGrowTextarea
          id="chain-step-guidance"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          rows={1}
          placeholder="What should this reviewer weigh? Optional."
          aria-label="Guidance"
          className={`${INSET_TEXTAREA_CLASS} w-full`}
          style={INSET_STYLE}
        />
      </div>

      {/* Named per step, only where it is actually true: timeout_seconds,
          depends_on, metadata, parallel_group, condition and similar axes
          have no control anywhere in this modal, are preserved losslessly
          through `_stepRaw` (chain-editor-state.ts), and are otherwise
          invisible to whoever opens this step. Neutral tone (t8), matching
          the External/Role "Set over the API" hints above rather than the
          amber rejection note below — this is a fact about the step, not a
          departure from a rule the operator might expect. */}
      {hiddenAxes && (
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
          Set over the API: this step also carries {hiddenAxes}, and is left exactly as it is.
        </p>
      )}

      {/* Rejection semantics: stated, not chosen, and only when this step
          departs from the route's rule — same condition and copy as
          ChainStepCard's body used (its lines 226-241). */}
      {form.rejectionPolicy !== "abort" && (
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--gw-amber-t)" }}>
          {form.rejectionPolicy === "continue" &&
            "Set over the API: rejecting at this step does not stop the chain. Later steps still open, and the run reports as completed."}
          {form.rejectionPolicy === "branch" &&
            `Set over the API: rejecting at this step sends the chain back to step ${form.rejectionBranchTo ?? "?"}.`}
        </p>
      )}

      <button
        type="button"
        onClick={() => setAdvancedOpen((o) => !o)}
        aria-expanded={advancedOpen}
        className="gw-focus-ring flex cursor-pointer items-center gap-1.5 self-start border-none bg-transparent py-1 text-[12px] transition-colors hover:opacity-80"
        style={{ color: "var(--gw-t6)" }}
      >
        <ChevronRight
          size={12}
          style={{ transition: "transform .15s ease", transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        Advanced
      </button>

      {advancedOpen && (
        <div className="flex flex-col gap-3 pl-3" style={{ borderLeft: "1px solid rgba(var(--gw-line-rgb),.08)" }}>
          <div className="flex items-center gap-4">
            <RowLabel width={88}>ID</RowLabel>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                value={form.stepId}
                onChange={(e) => setForm((f) => ({ ...f, stepId: e.target.value, idManuallyEdited: true }))}
                placeholder="step_1"
                aria-label="Step ID"
                className={`${INSET_INPUT_CLASS} w-full font-mono text-[11.5px]`}
                style={INSET_STYLE}
              />
              {err("stepId") && (
                <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
                  {err("stepId")}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <RowLabel width={88}>Priority</RowLabel>
            <SelectMenu
              value={form.priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setForm((f) => ({ ...f, priority: v as Priority | "" }))}
              ariaLabel="Step priority"
              minWidth={112}
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={submit}>{isEdit ? "Save step" : "Add step"}</PrimaryButton>
      </div>
    </Modal>
  );
}
