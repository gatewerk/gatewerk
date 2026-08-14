/**
 * ActorRow — the "who" line at the top of a detail rail: avatar, name, and a
 * mono role label pushed right.
 *
 * Shared by the Inbox rail (`assignee`) and the History rail (`decided by`).
 * The two were pixel-identical apart from that label and had each grown their
 * own copy of the initials logic, which is exactly how the same defect came to
 * be fixed twice.
 *
 * The value is free text, and only some of it describes a person:
 *   - an EMAIL is a person. It is humanised into a name, and the initials come
 *     from that name (sarah.chen@acme.com → SC / Sarah Chen).
 *   - an ID is not. Every id in this system starts `gw`, so initials sliced off
 *     one read "GW" for every user alive — an avatar that cannot carry
 *     information, above a `gw_usr_…` dressed as a display name. Ids keep their
 *     own grammar: mono, quiet, no avatar.
 *   - anything else (today only "System") is a name but not a face. It reads as
 *     a name, without an avatar, because the avatar is reserved for people.
 */
import { displayName } from "@gatewerk/web-core/lib/utils";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { PersonAvatar } from "./PersonAvatar";

/** Matches this system's generated ids: gw_usr_…, gw_rev_…, gwk_…. */
const ID_SHAPE = /^gw[a-z]*_/i;

/** First letters of the first two words — "Sarah Chen" → SC, "sarah" → SA. */
export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

interface Props {
  /** Raw actor value: an email, an opaque id, or a plain name. */
  value: string;
  /** Mono label pushed to the right, e.g. "assignee" / "decided by". */
  role: string;
  /**
   * Quiet caveat on the name itself, e.g. "unverified" when a public review
   * link recorded a label the sharer typed rather than an identity anyone
   * confirmed. Absent by default: a name with nothing to qualify says nothing,
   * and a caveat that appeared on every row would stop meaning anything.
   *
   * Deliberately not coloured. Colour marks live attention, and this is a
   * property of a finished record, not something asking to be dealt with.
   */
  note?: string;
}

export function ActorRow({ value, role, note }: Props) {
  const { user } = useAuth();
  const isEmail = value.includes("@");
  const isId = !isEmail && ID_SHAPE.test(value);
  const label = isEmail ? displayName(value) : value;
  // Self-view only: there's no lookup-by-email for anyone else's photo yet,
  // so a row about a teammate still falls back to initials, correctly.
  const isCurrentUser = isEmail && user?.email.toLowerCase() === value.toLowerCase();

  return (
    <div className="flex items-center" style={{ gap: 10 }}>
      {isEmail && (
        <PersonAvatar
          userId={isCurrentUser ? user!.id : null}
          fallback={initialsOf(label)}
          size={24}
          radius={7}
          background="var(--gw-avatar)"
          border="1px solid rgba(var(--gw-line-rgb),.12)"
          color="var(--gw-t4)"
          fontSize={10}
        />
      )}
      <div
        className={
          isId ? "min-w-0 truncate font-mono text-[11.5px]" : "min-w-0 truncate text-[13px]"
        }
        style={{ color: isId ? "var(--gw-t6)" : "var(--gw-t4)" }}
      >
        {label}
      </div>
      {note && (
        <div
          className="shrink-0 font-mono"
          style={{ fontSize: 10.5, color: "var(--gw-t8)" }}
        >
          {note}
        </div>
      )}
      <div className="ml-auto shrink-0 font-mono" style={{ fontSize: 10.5, color: "var(--gw-t10)" }}>
        {role}
      </div>
    </div>
  );
}
