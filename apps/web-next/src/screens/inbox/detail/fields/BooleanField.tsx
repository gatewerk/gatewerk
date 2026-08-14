import { Toggle } from "../../../settings/_shared/Toggle";

interface Props {
  value: unknown;
  editable: boolean;
  onCommit: (v: boolean) => void;
}

/**
 * BooleanField — payload boolean as the app's shared Toggle (neutral-on:
 * green marks decisions, not state) + the field's
 * Enabled/Disabled label. Read-only renders the same switch, disabled.
 */
export function BooleanField({ value, editable, onCommit }: Props) {
  const boolVal = Boolean(value);
  return (
    <span className="inline-flex items-center" style={{ gap: 8 }}>
      <Toggle
        checked={boolVal}
        onChange={(v) => editable && onCommit(v)}
        disabled={!editable}
        aria-label={boolVal ? "Enabled" : "Disabled"}
      />
      <span className="text-[13px]" style={{ color: "var(--gw-t4)" }}>
        {boolVal ? "Enabled" : "Disabled"}
      </span>
    </span>
  );
}
