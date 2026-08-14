/**
 * Replay onboarding — handoff §E.
 *
 * The explicit failure of the pre-redesign flow was that a user who dismissed
 * onboarding had no path back. Two rows, because there are two flows and two
 * store keys: the admin's activation wizard and the reviewer's sample
 * walkthrough. Sharing one entry would mean replaying one persona's onboarding
 * and silently clearing the other's.
 *
 * The wizard row is cloud-only — `/onboarding` does not exist in a standalone
 * build, so offering to take a tour that leads to NotFound would be worse than
 * offering nothing. Self-hosted admins replay activation by having an empty
 * inbox, which is the OSS activation surface.
 *
 * This does NOT go in the icon rail. The prototype puts a "?" tile there, but
 * the rail's contents follow the shipped app's own chrome.
 */

import { useNavigate } from "react-router";
import { toast } from "sonner";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { ActionLink, SectionRule, SettingsRow, RowValue } from "../_shared/ui";
import { replayOnboarding } from "~/screens/onboarding/onboarding-store";
import { replayReviewerOnboarding } from "~/screens/onboarding/reviewer-store";

const STORAGE_BLOCKED = "Could not restart it. Try clearing this site's data and reloading.";

export function OnboardingReplaySection() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Each row is shown only to whoever the flow it replays actually runs for.
  // The wizard route exists in cloud builds and redirects admins; the sample
  // walkthrough mounts for non-admins (Inbox.tsx gates it on role). Showing
  // either to the other audience is a button that visibly does nothing, which
  // is worse than not offering it.
  const isAdmin = user?.role === "admin";
  const showWizardRow = isCloud() && isAdmin;
  const showWalkthroughRow = !isAdmin;

  // An admin in a standalone build has neither. Rendering the section header
  // over an empty list would be the same dead promise one level up.
  if (!showWizardRow && !showWalkthroughRow) return null;

  function replayWizard() {
    const result = replayOnboarding();
    if (!result.ok) {
      toast.error(STORAGE_BLOCKED);
      return;
    }
    navigate("/onboarding");
  }

  function replayWalkthrough() {
    const result = replayReviewerOnboarding();
    if (!result.ok) {
      toast.error(STORAGE_BLOCKED);
      return;
    }
    navigate("/");
  }

  // A single wrapping element, not a bare Fragment: AccountPane
  // renders this directly as a grid/flow child, and a Fragment's children
  // flatten into whatever container renders it — the same defect
  // NotificationsPane's own Fragment root caused when AccountPane's two
  // column grid was built (see AccountPane.tsx). A wrapper only around the
  // *rendered* content, not around the early `return null` above, matters
  // here specifically: it keeps "onboarding fully absent" meaning zero DOM
  // nodes, not an empty box.
  return (
    <section className="flex flex-col gap-[26px]">
      <SectionRule label="Onboarding" />
      <div>
        {showWizardRow && (
          <SettingsRow
            label="Setup"
            action={<ActionLink onClick={replayWizard}>Run it again</ActionLink>}
          >
            <RowValue>Name your project, get a key, connect an agent.</RowValue>
          </SettingsRow>
        )}
        {showWalkthroughRow && (
          <SettingsRow
            label="Walkthrough"
            divider={false}
            action={<ActionLink onClick={replayWalkthrough}>Show me again</ActionLink>}
          >
            <RowValue>Practice a decision on a sample. Nothing is sent.</RowValue>
          </SettingsRow>
        )}
      </div>
    </section>
  );
}
