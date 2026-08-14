/**
 * TextInput/TextArea — the inset control surface (INSET_STYLE +
 * INSET_INPUT_CLASS, the settings/templates recipe) with Field wiring.
 * Outside a Field they degrade to plain inputs (id/aria props omitted),
 * so they are safe to adopt incrementally. Inside a Field the generated id
 * always wins so the label linkage never silently breaks; a caller-supplied
 * id is a dev-time error.
 */
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { useFieldContext } from "./Field";
import { INSET_INPUT_CLASS, INSET_STYLE, INSET_TEXTAREA_CLASS } from "./field-styles";

function useFieldAria(callerId?: string): {
  id?: string;
  "aria-invalid"?: "true";
  "aria-describedby"?: string;
} {
  const field = useFieldContext();
  if (!field) return {};
  if (import.meta.env.DEV && callerId !== undefined && callerId !== field.id) {
    console.error(
      `TextInput/TextArea: id "${callerId}" is ignored inside a Field. ` +
        "The Field's generated id keeps the label linked; remove the id prop or move the input outside the Field.",
    );
  }
  // id is always Field-owned (label linkage must never silently break). The
  // error-only keys are omitted entirely rather than set to undefined when
  // there is no error, so a caller's own aria-invalid/aria-describedby
  // survives the spread instead of losing to an own-but-undefined key.
  if (!field.hasError) return { id: field.id };
  return { id: field.id, "aria-invalid": "true", "aria-describedby": field.errorId };
}

export function TextInput({ className = "", style, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const aria = useFieldAria(props.id);
  return (
    <input
      {...props}
      {...aria}
      className={`${INSET_INPUT_CLASS} w-full ${className}`}
      style={{ ...INSET_STYLE, ...style }}
    />
  );
}

export function TextArea({
  autoGrow = false,
  className = "",
  style,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean }) {
  const aria = useFieldAria(props.id);
  const merged = {
    ...props,
    ...aria,
    className: `${INSET_TEXTAREA_CLASS} ${className}`,
    style: { ...INSET_STYLE, ...style },
  };
  return autoGrow ? <AutoGrowTextarea {...merged} /> : <textarea {...merged} />;
}
