/**
 * The inbox's Tier-1 state: nothing is narrowing the list and the queue is
 * empty. The Empty States board draws exactly one of these — the listening
 * state — and this renders that, unconditionally.
 *
 * It used to branch on setup progress: no templates yet said "Create your
 * first template", templates but no webhooks said "Connect a webhook", and
 * only a fully wired workspace reached "Inbox is clear". For self-hosters
 * the empty inbox IS the in-app handoff — "same listening state, less
 * ceremony" — so the ladder was cut.
 *
 * The ladder also made a claim it had no business making. A workspace with no
 * outbound webhook is not un-started — webhooks push events OUT, they are not
 * how reviews come IN — so "Connect a webhook" answered a question nobody
 * standing at an empty inbox was asking, and it displaced the one line that is
 * always true: we are listening, and whatever your agents send lands here.
 *
 * Cloud admins get the wizard at /onboarding instead and land here afterwards,
 * on these same visuals, which is what makes that transition read as continuous.
 */

import { Inbox as InboxIcon } from "lucide-react";
import { EmptyStateTier1 } from "~/components/empty-state";

export function InboxFirstRun() {
  return (
    <EmptyStateTier1
      icon={<InboxIcon size={18} strokeWidth={1.5} />}
      // The only ring="live" in the app. This is the one surface genuinely
      // waiting on a machine, which is exactly what the ring claims.
      ring="live"
      title="Inbox is clear"
      subtitle="New review requests from your agents will land here the moment they arrive."
      footer={{ kind: "status", variant: "live", label: "Listening" }}
    />
  );
}
