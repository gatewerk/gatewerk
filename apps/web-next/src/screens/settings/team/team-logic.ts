/**
 * Pure Team-section helpers. Role editing (PUT /settings/team/:id) is
 * deferred — this section only ever writes role via invite (POST invite)
 * and is_active via remove (DELETE), so there is no update-body builder
 * here, unlike apps/web's TeamSection.
 */
import type { TeamMember } from "@gatewerk/web-core/api/notifications";

/** Invite/roster role choices. "owner" is never offered here — it exists on
 *  the wire for Cloud workspaces but is assigned at signup, not invited. */
export const ROLE_OPTIONS = [
  { value: "reviewer", label: "Reviewer" },
  { value: "admin", label: "Admin" },
] as const;

const VALID_INVITE_ROLES = new Set(ROLE_OPTIONS.map((o) => o.value));

/** Mirrors the backend's self-edit guard on DELETE /settings/team/:id
 *  (`cannot_edit_self`) — the UI must not offer removing your own account. */
export function canRemoveMember(memberId: string, currentUserId: string | undefined): boolean {
  return memberId !== currentUserId;
}

export function buildInviteBody(email: string, role: string): { email: string; role: "admin" | "reviewer" } {
  const trimmedEmail = email.trim();
  const safeRole = VALID_INVITE_ROLES.has(role as "admin" | "reviewer") ? (role as "admin" | "reviewer") : "reviewer";
  return { email: trimmedEmail, role: safeRole };
}

// Display-only — "owner" is a real roster role (Cloud workspaces) even
// though it's never an invite choice (ROLE_OPTIONS above), so the badge
// still needs a Title Case label instead of falling back to the raw string.
const ROLE_BADGE_LABELS: Record<string, string> = {
  reviewer: "Reviewer",
  admin: "Admin",
  owner: "Owner",
};

export function roleBadgeLabel(role: string): string {
  return ROLE_BADGE_LABELS[role] ?? role;
}

/**
 * GET /settings/team returns every reviewer regardless of is_active — it
 * also backs ShareViaLinkDialog's recipient picker, which has its own
 * reasons to see inactive rows. This section has no reactivate control, so
 * a member the admin just Removed (DELETE, soft-delete) must not keep
 * appearing with a live Remove button that does nothing new — filter to
 * active members for display.
 */
export function activeMembers(members: TeamMember[]): TeamMember[] {
  return members.filter((m) => m.is_active);
}
