/**
 * Fields — the `fields` control group. Mirrors ActionsSection: a static row
 * (name, type chip, status chips) plus Edit/Remove icon buttons, all editing
 * done through FieldModal. Used to expand a configure panel in place
 * (`openRow` state) — that panel is now the modal, so every row stays one
 * fixed height, matching Actions.
 */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { TemplateField } from "@gatewerk/shared";
import { fieldNeedsOptions } from "@gatewerk/web-core/state/templates/detail/field-options-state";
import { AddLink, CARD_STYLE, EmptyState, INSET_STYLE, SectionHeader } from "../_ui";
import { FieldModal } from "./FieldModal";

type ModalState = { kind: "closed" } | { kind: "add" } | { kind: "edit"; index: number };

interface Props {
  isEditing: boolean;
  fields: TemplateField[];
  setFields: (next: TemplateField[]) => void;
  removeField: (index: number) => void;
}

export function FieldsSection({ isEditing, fields, setFields, removeField }: Props) {
  const [modal, setModal] = useState<ModalState>({ kind: "closed" });

  function handleSubmit(field: TemplateField) {
    if (modal.kind === "add") {
      setFields([...fields, field]);
    } else if (modal.kind === "edit") {
      setFields(fields.map((f, i) => (i === modal.index ? field : f)));
    }
  }

  const editing = modal.kind === "edit" ? fields[modal.index] : undefined;

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        label="Fields"
        right={
          isEditing ? (
            <AddLink onClick={() => setModal({ kind: "add" })}>
              <Plus size={12} strokeWidth={2.2} />
              Add field
            </AddLink>
          ) : (
            <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
              {fields.length} {fields.length === 1 ? "field" : "fields"}
            </span>
          )
        }
      />

      {fields.length === 0 ? (
        <EmptyState
          title={isEditing ? "No fields yet." : "This template carries no fields."}
          hint={isEditing ? "A field is one piece of the payload a reviewer reads." : undefined}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {fields.map((field, i) => {
            const needsOptions = isEditing && fieldNeedsOptions(field);
            return (
              <div
                key={i}
                className="flex items-center gap-3 rounded-[11px] px-4 py-2.5"
                style={{
                  ...CARD_STYLE,
                  border: needsOptions ? "1px solid rgba(var(--gw-amber-rgb),.32)" : CARD_STYLE.border,
                }}
              >
                {/* The name is the row's identity and must never be squeezed
                    out. It used to carry flex-1, which in flexbox means a
                    basis of 0, while the label next to it kept an auto basis
                    sized to its content. Under pressure the name lost every
                    time: a long label pushed it out of the row completely and
                    then truncated itself as well, so neither was readable.
                    Now the name holds its width up to 45% and the label is
                    the one that flexes. title= on both so the full string is
                    reachable on hover instead of only inside the editor. */}
                <span
                  className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[12px]"
                  style={{ color: "var(--gw-t4)" }}
                  title={field.name || undefined}
                >
                  {field.name || "Untitled field"}
                </span>
                {field.label &&
                  field.label.trim().toLowerCase() !== field.name.replace(/_/g, " ").trim().toLowerCase() && (
                    <span
                      className="min-w-0 flex-1 truncate text-[12px]"
                      style={{ color: "var(--gw-t6)" }}
                      title={field.label}
                    >
                      {field.label}
                    </span>
                  )}
                {needsOptions && (
                  <span
                    className="shrink-0 rounded-[5px] px-[7px] py-0.5 text-[10.5px]"
                    style={{
                      color: "var(--gw-amber-t)",
                      background: "rgba(var(--gw-amber-rgb),.12)",
                      border: "1px solid rgba(var(--gw-amber-rgb),.32)",
                    }}
                  >
                    Needs options
                  </span>
                )}
                {field.editable === true && (
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--gw-t8)" }}>
                    editable
                  </span>
                )}
                <span
                  className="shrink-0 rounded-[6px] px-2.5 py-0.5 font-mono text-[11px]"
                  style={{ ...INSET_STYLE, color: "var(--gw-t5)" }}
                >
                  {field.type}
                </span>
                {isEditing && (
                  <>
                    <button
                      type="button"
                      title="Edit field"
                      aria-label={`Edit ${field.name || `field ${i + 1}`}`}
                      onClick={() => setModal({ kind: "edit", index: i })}
                      className="gw-focus-ring flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] border-none bg-transparent transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)]"
                      style={{ color: "var(--gw-t8)" }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      title="Remove field"
                      aria-label={`Remove ${field.name || `field ${i + 1}`}`}
                      onClick={() => removeField(i)}
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

      {modal.kind !== "closed" && (
        <FieldModal initial={editing} onClose={() => setModal({ kind: "closed" })} onSubmit={handleSubmit} />
      )}
    </section>
  );
}
