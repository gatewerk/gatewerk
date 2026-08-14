import { SCOPES, type Scope } from "@gatewerk/shared";

export const ROLES = ["admin", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

// Admin inherits every scope by construction — the canonical list in
// @gatewerk/shared is the single source of truth, so adding a new scope
// cannot silently lock admins out.
const ADMIN_SCOPES: readonly Scope[] = SCOPES;

// Reviewers: least-privilege inbox access. No templates:write, no reviews:create,
// no audit:read, no feedback:read. Notes: 5 of 7 scopes — excludes
// delete_any_shared (admin-only per spec §6.2) and unpin_any (admin-only).
const REVIEWER_SCOPES: readonly Scope[] = [
  "reviews:read",
  "reviews:decide",
  "reviews:claim",
  "reviews:release",
  "templates:read",
  "stats:read",
  "notes:read",
  "notes:write",
  "notes:edit_own",
  "notes:delete_own",
  "notes:pin",
];

export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  admin: ADMIN_SCOPES,
  reviewer: REVIEWER_SCOPES,
};
