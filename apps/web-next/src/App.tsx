import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router";
import { Loader2 } from "lucide-react";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { QUIET_MODE } from "@gatewerk/web-core/lib/quiet-mode";
import { AppShell } from "~/shell/AppShell";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { RequireAuth } from "~/shell/RequireAuth";
import { RedirectIfAuthed } from "~/shell/RedirectIfAuthed";
import { NotFound } from "~/screens/NotFound";
import { Inbox } from "~/screens/inbox/Inbox";
import { Settings } from "~/screens/settings/Settings";
import Login from "~/auth/Login";
import ResetPassword from "~/auth/ResetPassword";
import ChangePassword from "~/auth/ChangePassword";
import AcceptInvite from "~/auth/AcceptInvite";
import ExternalReview from "~/screens/review/ExternalReview";
import { Unsubscribe } from "~/screens/unsubscribe/Unsubscribe";
import { Templates } from "~/screens/templates/Templates";
import { History } from "~/screens/history/History";
import { Notes } from "~/screens/notes/Notes";
import { DeskOnlyOnNarrow } from "~/screens/mobile/DeskOnly";

// Cloud-only auth surface. Each is null in a standalone build, which both drops
// the route and lets Rollup delete the import — see apps/web-next/ee/README.md.
const CloudLogin = isCloud() ? lazy(() => import("@ee/auth/CloudLogin")) : null;
const CloudSignup = isCloud() ? lazy(() => import("@ee/auth/CloudSignup")) : null;
const OAuthCallback = isCloud() ? lazy(() => import("@ee/auth/OAuthCallback")) : null;
const AuthConfirm = isCloud() ? lazy(() => import("@ee/auth/AuthConfirm")) : null;

// The activation wizard is AGPL src/, not ee/ — apps/web ships the same page
// under the server licence and moving it would relicense it. Only the ROUTE is
// cloud-gated, which is what keeps the chunk out of the standalone bundle: the
// same isCloud() constant folding that deletes the ee/ imports above deletes
// this dynamic import too. OSS activation is the inbox empty state instead
// (per the onboarding design: no wizard, same listening state, less
// ceremony).
const OnboardingWizard = isCloud()
  ? lazy(() => import("~/screens/onboarding/OnboardingWizard"))
  : null;

function RouteFallback() {
  return (
    <div className="grid h-screen place-items-center bg-page">
      <Loader2 size={24} className="animate-spin text-t6" />
    </div>
  );
}

/**
 * `/reviews/:id` is not a screen — the inbox holds selection in `?review=`, so a
 * deep link folds back into the list rather than opening a second detail route.
 * Mirrors apps/web/src/catchall.tsx:18-22 exactly, including the id-less
 * fallback: react-router can match this path with an empty param, and
 * `/?review=` would then land on the inbox with a selection that resolves to
 * nothing.
 */
function ReviewDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  return <Navigate to={`/?review=${id}`} replace />;
}

/**
 * `/settings` means two different things depending on the width.
 *
 * On a laptop it is a waypoint: the two column screen always shows a pane, so
 * landing on the bare path picks the first one. On a phone there is no second
 * column, so `/settings` IS the section menu, and it is where the pane's back
 * button goes. Keeping the unconditional redirect there meant the menu could
 * never render and back appeared to do nothing, because the redirect fired
 * again as soon as the pane unmounted.
 */
function SettingsIndex() {
  const narrow = useNarrowViewport();
  if (narrow) return <Settings />;
  return <Navigate to="/settings/account" replace />;
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
    <Routes>
      {/* ── Public routes (no shell, no auth gate) ── */}
      {/* Cloud swaps the whole sign in screen: Supabase owns the session there,
          so the OSS password form would be signing in against the wrong thing. */}
      <Route path="login" element={CloudLogin ? <CloudLogin /> : <Login />} />
      {/* Cloud-only. In standalone these three routes do not exist at all and
          fall through to NotFound, which is the correct answer: there is no
          Supabase to sign up to and no email template pointing here. */}
      {/* Gated by QUIET_MODE (@gatewerk/web-core/lib/quiet-mode); hidden pre-announcement. */}
      {CloudSignup && !QUIET_MODE && (
        <Route
          path="signup"
          element={
            <RedirectIfAuthed>
              <CloudSignup />
            </RedirectIfAuthed>
          }
        />
      )}
      {OAuthCallback && <Route path="auth/callback" element={<OAuthCallback />} />}
      {AuthConfirm && <Route path="auth/confirm" element={<AuthConfirm />} />}
      <Route path="reset-password" element={<ResetPassword />} />
      {/* Signed in, but not inside the shell: the forced first-login change is
          the one thing a reviewer must do before reaching the inbox, so it
          renders on the auth surface rather than behind the app chrome. */}
      <Route path="change-password" element={<ChangePassword />} />
      {/* Signed in, outside the shell, for the same reason change-password is:
          activation is the one thing standing between a brand new cloud admin
          and an inbox, so it gets the whole screen rather than sitting inside
          chrome that is not useful yet.

          This is where CloudSignup, OAuthCallback and AuthConfirm all navigate
          after provisioning. Until it existed, every new cloud user landed on
          NotFound — the hard gate on the apps/web cutover. */}
      {OnboardingWizard && (
        <Route
          path="onboarding"
          element={
            <RequireAuth>
              <OnboardingWizard />
            </RequireAuth>
          }
        />
      )}
      {/* Accept invite. This was a <Navigate to="/login"> because Team was
          hidden so no UI could create an invite and nobody should hold a
          link. Cutover ruling D1
          ships a minimal Team surface, so the premise is gone and the page is
          restored. Until A4 lands the invite generator, links can only be
          minted through the API — the page works, it just has no UI feeding it
          yet. */}
      <Route path="invite/:token" element={<AcceptInvite />} />
      {/* External review link target — the public recipient page.
          Design: Gatewerk External Review.dc.html. */}
      <Route path="r/:token" element={<ExternalReview />} />
      {/* Digest unsubscribe landing — API already flipped the pref before
          302-redirecting here; purely presentational, no token handling.
          Stage 3b §9.5. */}
      <Route path="unsubscribe" element={<Unsubscribe />} />

      {/* ── Authenticated shell ── */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Inbox />} />
        <Route path="reviews/:id" element={<ReviewDetailRedirect />} />
        <Route path="history" element={<History />} />
        <Route
          path="templates"
          element={
            <DeskOnlyOnNarrow what="Templates">
              <Templates />
            </DeskOnlyOnNarrow>
          }
        />
        {/* Notes ships at launch as a named destination. The eleven note axes
            in surface-tiers/workspace.ts were retiered accordingly. Framed in
            copy as oversight memory; named Notes, because the API and the
            agent tool say note. */}
        <Route path="notes" element={<Notes />} />
        {/* Metrics does not ship at launch, which is why no Metrics design was
            ever drawn. The screen is BUILT and kept as inventory in
            screens/metrics/ with its 12 model cases still running.

            When it returns it belongs in the ICON RAIL, not the drawer: the
            History design's rail carries a chart icon in that slot. */}
        <Route path="metrics" element={<Navigate to="/" replace />} />
        {/* Settings shell: /settings → /settings/account redirect (the
            prototype's first pane).

            On a phone /settings is a real destination, not a waypoint: it is
            the section menu, and it is what the pane's back button returns to.
            Redirecting it unconditionally made the menu unreachable and turned
            back into a no-op, because the redirect fired again the moment the
            pane left. See SettingsIndex. */}
        <Route path="settings" element={<SettingsIndex />} />
        <Route path="settings/*" element={<Settings />} />
        {/* /profile is not a screen. It never was one in apps/web either —
            Profile.tsx there is a bare <Navigate to="/settings">. The profile
            surface itself lives inside Settings. Keeping the redirect means
            existing links and bookmarks still land somewhere real. */}
        <Route path="profile" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
