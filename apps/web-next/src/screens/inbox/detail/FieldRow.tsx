/**
 * FieldRow — key column (perm icon + label) + value slot + SeePreviousVersion.
 *
 * Spec §4: NO divider line between fields — rows are grouped by whitespace.
 * Row: flex, gap 22, padding 7px 10px, margin 0 -10px, radius 8, hover
 * rgba(var(--gw-line-rgb),.03). Key column clamp(112px,22%,150px), mono 12.5px.
 */
import { Pencil, Lock } from "lucide-react";
import type { FieldDescriptor } from "./payload-fields";
import { FieldValue } from "./FieldValue";
import { SeePreviousVersion } from "./SeePreviousVersion";

interface Props {
  field: FieldDescriptor;
  /** Current display value (may be staged edit or original). */
  displayValue: unknown;
  /** Original submitted value. */
  originalValue: unknown;
  /** True if this field has a staged edit (displayValue !== originalValue). */
  isEdited: boolean;
  onCommit: (v: unknown) => void;
  onRevert: () => void;
}

export function FieldRow({
  field,
  displayValue,
  originalValue,
  isEdited,
  onCommit,
  onRevert,
}: Props) {
  return (
    <div
      className="flex rounded-[8px] transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.03)]"
      style={{ gap: 22, padding: "7px 10px", margin: "0 -10px" }}
    >
      {/* Key column — clamp(112px, 22%, 150px) per spec §4 */}
      <div
        className="flex shrink-0 items-start gap-[7px]"
        style={{ width: "clamp(112px, 22%, 150px)", paddingTop: 2 }}
      >
        {field.editable ? (
          <Pencil size={10} style={{ color: "var(--gw-t8)", marginTop: 3, flexShrink: 0 }} />
        ) : (
          <Lock size={10} style={{ color: "var(--gw-t9)", marginTop: 3, flexShrink: 0 }} />
        )}
        <span
          className="font-mono text-[12.5px] leading-tight"
          style={{
            color: field.editable ? "var(--gw-t8)" : "var(--gw-t9)",
            overflowWrap: "break-word",
          }}
        >
          {field.label}
        </span>
      </div>

      {/* Value slot */}
      <div className="min-w-0 flex-1">
        <FieldValue
          type={field.type}
          value={displayValue}
          editable={field.editable}
          options={field.options}
          onCommit={onCommit}
        />
        {isEdited && (
          <SeePreviousVersion originalValue={originalValue} onRevert={onRevert} />
        )}
      </div>
    </div>
  );
}
