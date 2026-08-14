/**
 * TeamPane — roster / invite orchestrator. Structurally WebhooksPane's
 * twin: SectionRule with the pane's one green primary ("Invite member"),
 * flat hairline rows, a Modal-hosted create flow. The create flow has two
 * views instead of one (form, then a reveal-once link) because invite
 * generation returns a bearer link the admin must copy before it's gone —
 * same two-step shape ApiKeysPane's create→reveal uses for a raw API key.
 *
 * No role/name editing here (deferred — PUT /settings/team/:id is unused).
 * Plain useMutation + invalidate, no optimistic layer, matching every other
 * Settings pane.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteTeamMemberMutation,
  generateInviteTokenMutation,
  listTeam,
  type TeamMember,
} from "@gatewerk/web-core/api/notifications";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { Modal } from "~/components/Modal";
import { EmptyState } from "../../templates/_ui";
import { GreenPill, SectionRule } from "../_shared/ui";
import { InviteForm } from "./InviteForm";
import { InviteLinkPanel } from "./InviteLinkPanel";
import { TeamRow } from "./TeamRow";
import { activeMembers, buildInviteBody } from "./team-logic";

type View = { mode: "list" } | { mode: "invite" } | { mode: "invite-result"; inviteUrl: string; email: string };

function assertNever(v: never): never {
  throw new Error(`unreachable view: ${JSON.stringify(v)}`);
}

export function TeamPane() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [view, setView] = useState<View>({ mode: "list" });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("reviewer");

  const { data, isLoading, error } = useQuery(listTeam({}));
  const members: TeamMember[] = activeMembers(data?.items ?? []);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["settings", "team"] });
  }

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const inviteMutation = useMutation({
    mutationFn: generateInviteTokenMutation,
    onSuccess: (result, body) => {
      toast.success(`Invite link generated for ${body.email}`);
      setView({ mode: "invite-result", inviteUrl: result.invite_url, email: body.email });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTeamMemberMutation,
    onSuccess: (_result, vars) => {
      invalidate();
      const name = members.find((m) => m.id === vars.id)?.name || "Member";
      toast.success(`"${name}" removed`);
    },
    onError,
  });

  function startInvite() {
    setInviteEmail("");
    setInviteRole("reviewer");
    setView({ mode: "invite" });
  }

  function closeModal() {
    setView({ mode: "list" });
  }

  function submitInvite() {
    inviteMutation.mutate(buildInviteBody(inviteEmail, inviteRole));
  }

  function renderModal() {
    if (view.mode === "list") return null;
    if (view.mode === "invite") {
      return (
        <Modal onClose={closeModal} ariaLabel="Invite member" title="Invite member" width={480}>
          <InviteForm
            email={inviteEmail}
            role={inviteRole}
            onEmailChange={setInviteEmail}
            onRoleChange={setInviteRole}
            onCancel={closeModal}
            onSubmit={submitInvite}
            isSubmitting={inviteMutation.isPending}
          />
        </Modal>
      );
    }
    if (view.mode === "invite-result") {
      return (
        <Modal
          onClose={closeModal}
          ariaLabel={`Invite link for ${view.email}`}
          title={`Invite link for ${view.email}`}
          width={480}
          closeOnBackdrop={false}
        >
          <InviteLinkPanel inviteUrl={view.inviteUrl} email={view.email} onDone={closeModal} />
        </Modal>
      );
    }
    return assertNever(view);
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
      </div>
    );
  }

  if (error) {
    return <EmptyState title="Could not load team" hint={error instanceof Error ? error.message : undefined} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-[22px]">
      <SectionRule label="Team" right={<GreenPill onClick={startInvite}>Invite member</GreenPill>} />

      {members.length > 0 ? (
        <div className="flex flex-col">
          {members.map((m) => (
            <TeamRow
              key={m.id}
              member={m}
              currentUserId={user?.id}
              onRemove={() => deleteMutation.mutate({ id: m.id })}
            />
          ))}
        </div>
      ) : (
        <EmptyState title="No team members yet" hint="Invite reviewers to collaborate on decisions made in this project." />
      )}

      {renderModal()}
    </div>
  );
}
