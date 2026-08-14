/**
 * Add or edit one action. Two visible controls carrying four declared axes:
 *
 *   Label  ->  label, and auto slugs id
 *   Role   ->  kind + decision_value together
 *
 * The fourth role is **Notify**, not "Other". "Other" invites an author to
 * write "Send it to legal", which compiles to a side_effect that fires a
 * webhook and moves nothing: a button that claims to route and does not.
 * Custody to a person is a real capability, held for after launch.
 *
 * Every transformation is `action-editor-modal-state`, which is where the
 * preserved roadmap axes and the ID sanitiser live and where they are tested.
 *
 * Chrome (backdrop, focus trap, escape-layer stack, the reserved title zone) now comes from the shared Modal.
 */
import { useEffect, useRef, useState } from "react";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";
import {
  ACTION_ROLES,
  EMPTY_FORM,
  ROLE_LABELS,
  allTouched,
  canonicalToFormState,
  extractPreserved,
  labelToActionId,
  roleOf,
  roleOwnsDestructive,
  sanitizeActionId,
  validate,
  type ActionRole,
  type FormErrors,
  type FormState,
} from "@gatewerk/web-core/state/templates/detail/action-editor-modal-state";
import { Modal } from "~/components/Modal";
import { GhostButton, INSET_INPUT_CLASS, INSET_STYLE, PrimaryButton, Toggle } from "../_ui";

const ROLE_HINTS: Record<ActionRole, string> = {
  approve: "Decides the review as approved.",
  reject: "Decides the review as rejected.",
  send_back: "Hands the review back to the agent for another attempt.",
  notify: "Fires a webhook and leaves the review where it is.",
};

interface Props {
  initial?: TemplateActionConfigCanonical;
  existingIds: readonly string[];
  /** Roles held by the OTHER actions, so the demotion can be announced up front. */
  existingRoles: readonly ActionRole[];
  onClose: () => void;
  onSubmit: (action: TemplateActionConfigCanonical) => void;
}

export function ActionModal({ initial, existingIds, existingRoles, onClose, onSubmit }: Props) {
  const isEdit = initial !== undefined;
  const [form, setForm] = useState<FormState>(() => (initial ? canonicalToFormState(initial) : EMPTY_FORM));
  const [errors, setErrors] = useState<FormErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  // Once the operator edits the ID, stop deriving it from the label.
  const [idManual, setIdManual] = useState(isEdit);
  const preservedRef = useRef(initial ? extractPreserved(initial) : {});
  const previousRole = initial ? roleOf(initial) : undefined;
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  function submit() {
    setTouched(allTouched);
    const result = validate(form, preservedRef.current, {
      isEdit,
      initialId: initial?.id,
      existingIds,
      previousRole,
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSubmit(result.value);
    onClose();
  }

  // Only approve and reject are exclusive: they are the two that carry a
  // decision_value, and the server allows at most one action per value. Taking
  // one demotes the incumbent to Notify, so the modal says so before the click
  // rather than after.
  const roleIsTaken =
    (form.role === "approve" || form.role === "reject") && existingRoles.includes(form.role);

  return (
    <Modal
      onClose={onClose}
      ariaLabel={isEdit ? "Edit action" : "Add action"}
      title={isEdit ? "Edit action" : "Add action"}
      subtitle="Name the button, and say what taking it means."
    >
      {/* Label */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="action-label" className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Label
        </label>
        <input
          id="action-label"
          ref={labelRef}
          value={form.label}
          maxLength={60}
          onChange={(e) => {
            const label = e.target.value;
            setForm((f) => ({ ...f, label, ...(idManual ? {} : { id: labelToActionId(label) }) }));
          }}
          onBlur={() => setTouched((t) => ({ ...t, label: true }))}
          placeholder="Approve"
          className={`${INSET_INPUT_CLASS} w-full`}
          style={INSET_STYLE}
        />
        {touched.label && errors.label && (
          <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
            {errors.label}
          </span>
        )}
      </div>

      {/* Role */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px]" style={{ color: "var(--gw-t6)" }} id="action-role-label">
          Role
        </span>
        <div role="radiogroup" aria-labelledby="action-role-label" className="grid grid-cols-2 gap-1.5">
          {ACTION_ROLES.map((role) => {
            const on = form.role === role;
            return (
              <button
                key={role}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setForm((f) => ({ ...f, role }))}
                className="gw-focus-ring flex h-8 cursor-pointer items-center justify-center rounded-[9px] text-[12px] transition-colors"
                style={{
                  background: on ? "rgba(var(--gw-hi-rgb),.10)" : "transparent",
                  border: `1px solid rgba(var(--gw-line-rgb),${on ? ".22" : ".10"})`,
                  color: on ? "var(--gw-t2)" : "var(--gw-t6)",
                  fontWeight: on ? 600 : 500,
                }}
              >
                {ROLE_LABELS[role]}
              </button>
            );
          })}
        </div>
        <span
          className="text-[11px] leading-relaxed"
          style={{ color: roleIsTaken ? "var(--gw-amber-t)" : "var(--gw-t8)" }}
        >
          {roleIsTaken
            ? "Another action already has this role. Saving moves that one to Notify."
            : form.role === ""
              ? "What the reviewer decides by taking this action."
              : ROLE_HINTS[form.role]}
        </span>
        {errors.role && (
          <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
            {errors.role}
          </span>
        )}

        {/* Only on the two roles that have no colour of their own. Approve
            and reject already ARE their colour, so offering the switch there
            would offer a contradiction — and the reviewer's button honours
            `style: "destructive"` on every surface already, so this is the
            editor catching up with what the product could always do. */}
        {roleOwnsDestructive(form.role) && (
          <div className="flex items-center gap-2.5 pt-1">
            <Toggle
              checked={form.destructive}
              label="Reviewer sees this action in red"
              onChange={() => setForm((f) => ({ ...f, destructive: !f.destructive }))}
            />
            <span className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
              Reviewer sees this action in red
            </span>
          </div>
        )}
      </div>

      {/* Action ID */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="action-id" className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Action ID
        </label>
        <input
          id="action-id"
          value={form.id}
          maxLength={40}
          onChange={(e) => {
            setIdManual(true);
            setForm((f) => ({ ...f, id: sanitizeActionId(e.target.value) }));
          }}
          onBlur={() => setTouched((t) => ({ ...t, id: true }))}
          placeholder="approve"
          className={`${INSET_INPUT_CLASS} w-full font-mono text-[11.5px]`}
          style={INSET_STYLE}
        />
        <span className="text-[11px] leading-relaxed" style={{ color: "var(--gw-t8)" }}>
          Lowercase letters, digits and underscores. Agents call the action by this.
        </span>
        {touched.id && errors.id && (
          <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
            {errors.id}
          </span>
        )}
      </div>

      {errors._form && (
        <p className="text-[11.5px]" style={{ color: "var(--gw-red-t)" }} role="alert">
          {errors._form}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={submit}>{isEdit ? "Save action" : "Add action"}</PrimaryButton>
      </div>
    </Modal>
  );
}
