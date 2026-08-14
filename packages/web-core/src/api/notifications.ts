import { z } from "zod";
import {
  TeamMemberObjectSchema,
  TeamListResponseSchema,
  TeamInviteBodySchema,
  InviteResultSchema,
  type TeamInviteBody,
  type TeamUpdateBody,
} from "@gatewerk/shared";
import { defineQuery, defineMutation } from "./client/define";

export type TeamMember = z.infer<typeof TeamMemberObjectSchema>;
export type TeamListPage = z.infer<typeof TeamListResponseSchema>;
export type InviteResult = z.infer<typeof InviteResultSchema>;

type Empty = Record<string, never>;

export const listTeam = defineQuery<Empty, TeamListPage>({
  path: "/api/v1/settings/team",
  queryKey: () => ["settings", "team"] as const,
  responseSchema: TeamListResponseSchema,
});

export const generateInviteTokenMutation = defineMutation<TeamInviteBody, InviteResult>({
  path: "/api/v1/settings/team/invite",
  method: "POST",
  bodySchema: TeamInviteBodySchema,
  responseSchema: InviteResultSchema,
});

export const updateTeamMemberMutation = defineMutation<
  { id: string } & TeamUpdateBody,
  TeamMember
>({
  path: ({ id }: { id: string }) => `/api/v1/settings/team/${encodeURIComponent(id)}`,
  method: "PUT",
  responseSchema: TeamMemberObjectSchema,
});

export const deleteTeamMemberMutation = defineMutation<{ id: string }, void>({
  path: ({ id }: { id: string }) => `/api/v1/settings/team/${encodeURIComponent(id)}`,
  method: "DELETE",
  bodyless: true,
});

export const team = {
  list: () => listTeam.run({}),
  invite: (data: TeamInviteBody) => generateInviteTokenMutation(data),
  update: (id: string, data: TeamUpdateBody) => updateTeamMemberMutation({ id, ...data }),
  delete: (id: string) => deleteTeamMemberMutation({ id }),
};
