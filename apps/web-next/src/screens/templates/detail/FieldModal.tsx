/**
 * Add or edit one field. Mirrors ActionModal's shape (add/edit via one
 * modal, Cancel/Submit footer) — Fields is the control group that was still
 * expanding its row in place instead of using a modal like Actions already
 * does.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { FIELD_TYPES } from "@gatewerk/shared";
import type { FieldType, TemplateField } from "@gatewerk/shared";
import {
  addOption,
  changeFieldType,
  removeOption,
  renameOption,
  typeCarriesOptions,
} from "@gatewerk/web-core/state/templates/detail/field-options-state";
import { Modal } from "~/components/Modal";
import { AddLink, GhostButton, INSET_INPUT_CLASS, INSET_STYLE, PrimaryButton, SelectMenu, Toggle } from "../_ui";

// `video` is excluded because nothing can author one: it has a renderer in
// the inbox but no upload path, so offering it would produce a field a
// reviewer sees empty forever. Same exclusion FieldsSection's row-level type
// chip already applies.
const EDITOR_FIELD_TYPES = FIELD_TYPES.filter((t: FieldType) => t !== "video");
const TYPE_OPTIONS = EDITOR_FIELD_TYPES.map((t: FieldType) => ({ value: t, label: t }));

const EMPTY_FIELD: TemplateField = { name: "", type: "text", label: "" };

interface Props {
  initial?: TemplateField;
  onClose: () => void;
  onSubmit: (field: TemplateField) => void;
}

export function FieldModal({ initial, onClose, onSubmit }: Props) {
  const isEdit = initial !== undefined;
  const [field, setField] = useState<TemplateField>(initial ?? EMPTY_FIELD);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const nameError = touched && field.name.trim().length === 0 ? "A field needs a name." : undefined;

  function submit() {
    setTouched(true);
    if (field.name.trim().length === 0) return;
    onSubmit(field);
    onClose();
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={isEdit ? "Edit field" : "Add field"}
      title={isEdit ? "Edit field" : "Add field"}
      subtitle="One piece of the payload a reviewer reads."
      width={420}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-name" className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Name
        </label>
        <input
          id="field-name"
          ref={nameRef}
          value={field.name}
          onChange={(e) => setField((f) => ({ ...f, name: e.target.value }))}
          onBlur={() => setTouched(true)}
          placeholder="field_name"
          className={`${INSET_INPUT_CLASS} w-full font-mono text-[11.5px]`}
          style={INSET_STYLE}
        />
        {nameError && (
          <span className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
            {nameError}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-label" className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Label
        </label>
        <input
          id="field-label"
          value={field.label}
          onChange={(e) => setField((f) => ({ ...f, label: e.target.value }))}
          placeholder="What the reviewer sees"
          className={`${INSET_INPUT_CLASS} w-full`}
          style={INSET_STYLE}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Type
        </span>
        <SelectMenu
          value={field.type}
          options={TYPE_OPTIONS}
          onChange={(v) => setField((f) => ({ ...f, ...changeFieldType(f, v as FieldType) }))}
          ariaLabel="Field type"
          minWidth={140}
        />
      </div>

      <div className="flex items-center gap-2.5">
        <Toggle
          checked={field.editable === true}
          label="Reviewer can edit this field"
          onChange={() => setField((f) => ({ ...f, editable: !f.editable }))}
        />
        <span className="text-[12px]" style={{ color: "var(--gw-t6)" }}>
          Reviewer can edit
        </span>
      </div>

      {typeCarriesOptions(field.type) && (
        <div className="flex flex-col gap-1.5">
          <span
            className="font-mono text-[10px] font-semibold uppercase"
            style={{ letterSpacing: ".14em", color: "var(--gw-t8)" }}
          >
            Options
          </span>
          {(field.options ?? []).map((option, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <span className="h-[5px] w-[5px] shrink-0 rounded-full" style={{ background: "var(--gw-t8)" }} />
              <input
                value={option}
                onChange={(e) => setField((f) => ({ ...f, ...renameOption(f, oi, e.target.value) }))}
                placeholder="Choice the reviewer picks"
                className={`${INSET_INPUT_CLASS} w-full`}
                style={INSET_STYLE}
              />
              <button
                type="button"
                title="Remove option"
                aria-label={`Remove option ${oi + 1}`}
                onClick={() => setField((f) => ({ ...f, ...removeOption(f, oi) }))}
                className="gw-focus-ring flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-red-rgb),0.1)]"
                style={{ color: "var(--gw-t8)" }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <AddLink onClick={() => setField((f) => ({ ...f, ...addOption(f) }))}>
            <Plus size={12} strokeWidth={2.2} />
            Add option
          </AddLink>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={submit}>{isEdit ? "Save field" : "Add field"}</PrimaryButton>
      </div>
    </Modal>
  );
}
