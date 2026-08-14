/**
 * RailDetails — Zone 4 §1 (prototype details section, lines 469-482).
 *
 * Body: flex column, gap 13.
 * Assignee: UNLABELED row, hidden when unassigned. The row itself is
 * components/ActorRow, shared with History's "decided by" — see it for why an
 * email becomes a face and an id does not.
 * Detail rows: space-between — label sans 12px t8, value mono right-aligned:
 *   Priority: 11.5px, critical/high → red-t, normal → t5, low → t6
 *   Created: 12px t4 (date, not relative)
 *   Irreversibility: 11.5px, irreversible → red-t, costly → amber-t, else t6
 *   Callback: 11.5px t6, nowrap ellipsis max-width 160px
 */
import type { Review } from "@gatewerk/web-core/api/reviews";
import { ActorRow } from "~/components/ActorRow";
import { RulerTickHeader } from "~/components/RulerTickHeader";

interface Props {
  review: Review;
}

/**
 * Red is for `critical` alone. A live review's priority earns ink where a
 * template's default never does — the template is a setting, this is a thing
 * waiting on a decision — but "high" is common enough to become wallpaper,
 * and a colour that appears on most records marks nothing. Reserving red for
 * critical means red in this rail is rare, and therefore means something.
 */
function priorityColor(p: string): string {
  if (p === "critical") return "var(--gw-red-t)";
  if (p === "low") return "var(--gw-t6)";
  return "var(--gw-t5)";
}

function irrevColor(v: string | null | undefined): string {
  if (v === "irreversible") return "var(--gw-red-t)";
  if (v === "costly_reversible") return "var(--gw-amber-t)";
  return "var(--gw-t6)";
}

function DetailRow({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: React.ReactNode;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div className="flex items-center justify-between" style={{ gap: 12 }}>
      <span className="shrink-0 text-[12px]" style={{ color: "var(--gw-t8)" }}>
        {label}
      </span>
      <span className="font-mono" style={{ fontSize: 11.5, ...valueStyle }}>
        {value}
      </span>
    </div>
  );
}

export function RailDetails({ review }: Props) {
  const priority = review.priority ?? "normal";
  const assignee = review.assignee;
  const created = review.created_at ? review.created_at.slice(0, 10) : "";
  const irrev = review.irreversibility;

  return (
    <section>
      <RulerTickHeader label="Details" marginClassName="mb-[14px] mt-0" endTick={false} />

      <div className="flex flex-col" style={{ gap: 13 }}>
        {/* Assignee — unlabeled avatar row; hidden when unassigned */}
        {assignee && <ActorRow value={assignee} role="assignee" />}

        {/* A default renders as nothing. "Normal" priority and an unset
            irreversibility are the absence of a decision by whoever created
            the review, and a rail that recites them makes every ordinary
            record look configured. Only a priority that departs from normal,
            or an irreversibility somebody actually chose, earns a line. */}
        {priority !== "normal" && (
          <DetailRow
            label="Priority"
            value={<span style={{ textTransform: "capitalize" }}>{priority}</span>}
            valueStyle={{ color: priorityColor(priority) }}
          />
        )}
        <DetailRow
          label="Created"
          value={created}
          valueStyle={{ fontSize: 12, color: "var(--gw-t4)" }}
        />
        {irrev && (
          <DetailRow
            label="Irreversibility"
            value={irrev.replace("_", " ")}
            valueStyle={{ color: irrevColor(irrev) }}
          />
        )}
        {review.callback_url && (
          <DetailRow
            label="Callback"
            value={review.callback_url}
            valueStyle={{
              color: "var(--gw-t6)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 160,
              display: "inline-block",
            }}
          />
        )}
      </div>
    </section>
  );
}
