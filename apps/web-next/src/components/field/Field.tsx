/**
 * Field — the one label/error wiring for form controls. Renders a real
 * <label htmlFor> (screens today mostly have visually-adjacent labels the
 * accessibility tree cannot link), an optional error line, and exposes
 * {id, errorId, hasError} over context so TextInput/TextArea wire
 * aria-invalid/aria-describedby without every call site repeating it.
 * Label typography matches the settings forms' existing label recipe
 * (11.5px / 500 / --gw-t6) so migrations are pixel-identical.
 */
import { createContext, useContext, useId, type ReactNode } from "react";

interface FieldContextValue {
  id: string;
  errorId: string;
  hasError: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

export function Field({
  label,
  hideLabel = false,
  error,
  hint,
  className = "",
  children,
}: {
  label: string;
  hideLabel?: boolean;
  error?: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <FieldContext.Provider value={{ id, errorId, hasError: Boolean(error) }}>
      <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
        <label
          htmlFor={id}
          className={hideLabel ? "sr-only" : "text-[11.5px] font-medium"}
          style={hideLabel ? undefined : { color: "var(--gw-t6)" }}
        >
          {label}
        </label>
        {children}
        {error ? (
          <span id={errorId} className="text-[11px]" style={{ color: "var(--gw-red-t)" }}>
            {error}
          </span>
        ) : hint ? (
          <span className="text-[11px]" style={{ color: "var(--gw-t8)" }}>
            {hint}
          </span>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
