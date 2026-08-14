/**
 * Actions — the `actions` control group. Four declared axes (id, label, kind,
 * decision_value) drawn as two controls, per the action architecture design:
 * an action is a label plus a point in (outcome, custody).
 *
 * The eight roadmap axes (style, icon, order, requires_feedback, confirmation,
 * enabled_for_status, expose_to_recipient, webhook_event) and the agent-facing
 * description are not drawn and ride through `extractPreserved`.
 *
 * NO REORDER CONTROL, unlike apps/web. Two independent reasons:
 *   * `order` is roadmap tier and nothing writes it — apps/web's drag calls
 *     arrayMove and never sets it (surface-tiers/templates.ts, ACTION_AXES.order);
 *   * web-next's decision rail sorts by TONE, not by array position
 *     (screens/inbox/detail/rail/action-tones.ts), so nothing downstream could
 *     observe the order anyway.
 * A control that cannot change what the reviewer sees is not a control.
 */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";
import { collectValidation } from "@gatewerk/web-core/state/templates/detail/action-editor-state";
import {
  ROLE_LABELS,
  applySubmittedAction,
  roleOf,
} from "@gatewerk/web-core/state/templates/detail/action-editor-modal-state";
import { actionTone, type ActionTone } from "@gatewerk/web-core/state/action-tone";
import { ActionModal } from "./ActionModal";
import { AddLink, CARD_STYLE, EmptyState, SectionHeader } from "../_ui";

/**
 * The chip's ink is the tone the reviewer's button will actually have, read
 * from the one function the decision rail reads (`actionTone`).
 *
 * It used to be a role→colour table maintained here, and it had drifted: it
 * painted `send_back` blue while the rail painted that same button neutral,
 * and it could not show a `style: "destructive"` at all, so an action the
 * reviewer would meet in red sat in this list looking harmless. A preview
 * that derives its own answer is not previewing anything.
 */
const TONE_COLOR: Record<ActionTone, string> = {
  green: "var(--gw-green-t)",
  red: "var(--gw-red-t)",
  neutral: "var(--gw-t6)",
};

type ModalState = { kind: "closed" } | { kind: "add" } | { kind: "edit"; index: number };

interface Props {
  isEditing: boolean;
  actions: TemplateActionConfigCanonical[];
  setActions: (next: TemplateActionConfigCanonical[]) => void;
}

export function ActionsSection({ isEditing, actions, setActions }: Props) {
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const validation = collectValidation(actions);

  function handleSubmit(action: TemplateActionConfigCanonical) {
    if (modal.kind === "closed") return;
    // Taking a role another action holds demotes that action rather than
    // failing: the server's "at most one action per decision_value" rule drawn
    // as an affordance instead of a 422 the operator has to decode.
    setActions(applySubmittedAction(actions, action, modal.kind === "edit" ? modal.index : null));
  }

  const editing = modal.kind === "edit" ? actions[modal.index] : undefined;
  const others = actions.filter((_, i) => !(modal.kind === "edit" && i === modal.index));
  const otherIds = others.map((a) => a.id);
  const otherRoles = others.map((a) => roleOf(a));

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        label="Actions"
        right={
          isEditing ? (
            <AddLink onClick={() => setModal({ kind: "add" })}>
              <Plus size={12} strokeWidth={2.2} />
              Add action
            </AddLink>
          ) : undefined
        }
      />

      {actions.length === 0 ? (
        <EmptyState
          title={isEditing ? "No actions yet." : "This template defines no actions."}
          hint={isEditing ? "An action is a button the reviewer presses to decide." : undefined}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {actions.map((action, i) => {
            const role = roleOf(action);
            // "Approve · approve · Approve" said the same word three times.
            // The id earns its place only when it is not just the label
            // squeezed into snake_case.
            const idRedundant =
              action.id === action.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
            return (
              // py-2.5, not py-3: a field row and an action row now sit at the
              // same height in two columns of one grid, so a 4px difference in
              // padding reads as two lists that failed to line up. It was
              // invisible while they were 300px apart.
              <div key={action.id} className="flex items-center gap-3 rounded-[11px] px-4 py-2.5" style={CARD_STYLE}>
                <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--gw-t2)" }}>
                  {action.label}
                </span>
                {!idRedundant && (
                  <code className="shrink-0 font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
                    {action.id}
                  </code>
                )}
                {/* Role chip in the type-chip grammar (mono, lowercase, same
                    shape) with the role's ink — one chip species everywhere,
                    not two with clashing casing rules. */}
                <span
                  className="shrink-0 rounded-[6px] px-2.5 py-0.5 font-mono text-[11px]"
                  style={{
                    color: TONE_COLOR[actionTone(action)],
                    background: "var(--gw-inset-soft)",
                    border: "1px solid rgba(var(--gw-line-rgb),.10)",
                  }}
                >
                  {ROLE_LABELS[role].toLowerCase()}
                </span>
                {isEditing && (
                  <>
                    <button
                      type="button"
                      title="Edit action"
                      aria-label={`Edit ${action.label}`}
                      onClick={() => setModal({ kind: "edit", index: i })}
                      className="gw-focus-ring flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                      style={{ color: "var(--gw-t8)" }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      title="Remove action"
                      aria-label={`Remove ${action.label}`}
                      onClick={() => setActions(actions.filter((_, x) => x !== i))}
                      className="gw-focus-ring flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.1)]"
                      style={{ color: "var(--gw-t8)" }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* "At least 1 decision action required." is dropped here — DetailRail's
          disabled-Publish helper text and the Publish button's own tooltip
          already say this, and having it twice on screen said the same thing
          in two colours of red. "Decision values must be unique." has no
          other surface, so it still renders. */}
      {isEditing && validation.filter((msg) => msg !== "At least 1 decision action required.").length > 0 && (
        <div className="flex flex-col gap-1">
          {validation
            .filter((msg) => msg !== "At least 1 decision action required.")
            .map((msg) => (
              <p key={msg} className="text-[11.5px]" style={{ color: "var(--gw-red-t)" }} role="alert">
                {msg}
              </p>
            ))}
        </div>
      )}

      {modal.kind !== "closed" && (
        <ActionModal
          initial={editing}
          existingIds={otherIds}
          existingRoles={otherRoles}
          onClose={() => setModal({ kind: "closed" })}
          onSubmit={handleSubmit}
        />
      )}
    </section>
  );
}
