import { z } from "zod";

const IsoDateString = z.string();

// Team member / reviewer
export const TeamMemberObjectSchema = z.object({
  object: z.literal("reviewer").optional(),
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  is_active: z.boolean(),
  last_login_at: IsoDateString.nullable().optional(),
  created_at: IsoDateString,
});

export const TeamListResponseSchema = z.object({
  object: z.literal("list"),
  items: z.array(TeamMemberObjectSchema),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
});

// Canonical role enum mirrors the values understood by the requireRole
// middleware. `owner` exists for Cloud workspaces; OSS deployments use
// `admin` and `reviewer`. Constraining at the wire level prevents an admin
// from POSTing an arbitrary string into `reviewers.role` and breaking
// downstream role checks.
export const TeamRoleSchema = z.enum(["owner", "admin", "reviewer"]);

export const TeamInviteBodySchema = z.object({
  email: z.email(),
  role: TeamRoleSchema.optional(),
});

export const TeamUpdateBodySchema = z.object({
  name: z.string().min(1).optional(),
  role: TeamRoleSchema.optional(),
  is_active: z.boolean().optional(),
});

export const InviteResultSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  expires_at: IsoDateString,
  invite_url: z.string(),
  // Legacy field: the raw token is embedded in invite_url. Marked optional
  // for backward compatibility with consumers still parsing the old shape.
  token: z.string().optional(),
});

export type TeamMemberObject = z.infer<typeof TeamMemberObjectSchema>;
export type TeamListResponse = z.infer<typeof TeamListResponseSchema>;
export type TeamInviteBody = z.infer<typeof TeamInviteBodySchema>;
export type TeamUpdateBody = z.infer<typeof TeamUpdateBodySchema>;
export type InviteResult = z.infer<typeof InviteResultSchema>;
