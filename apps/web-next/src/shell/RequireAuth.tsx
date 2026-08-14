/**
 * RequireAuth — gates the authenticated app shell.
 * isLoading → centered spinner.
 * !isLoggedIn → <Navigate to="/login" replace />.
 * user.must_change_password → <Navigate to="/change-password" replace />.
 * cloud, admin, onboarding not yet done → <Navigate to="/onboarding" replace />.
 * else → render children.
 *
 * The onboarding redirect exists because the three cloud signup paths are not
 * the only way in: an admin who signs up, closes the tab and comes back later
 * arrives at an empty inbox with no route to activation. It carries three
 * conditions and all three are load bearing:
 *
 *  - `isCloud()` — the wizard route only exists in cloud builds. Without this,
 *    every OSS self-hoster's first admin login redirects to a path that does
 *    not exist, i.e. straight to NotFound. (apps/web's version omits the check
 *    and gets away with it only because it mounts the wizard unconditionally.)
 *  - `role === "admin"` — an invited reviewer has nothing to set up, and the
 *    wizard would be a wall between them and the review they were invited to.
 *  - `pathname !== "/onboarding"` — this component also wraps the wizard route
 *    itself, so without the exemption it redirects to itself forever, which
 *    presents as a white screen rather than a loop.
 */

import { Navigate, useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { isOnboardingComplete } from "~/screens/onboarding/onboarding-store";

interface RequireAuthProps {
  children: React.ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { isLoading, isLoggedIn, user } = useAuth();
  const { pathname } = useLocation();

  if (isLoading) {
    return (
      <div className="grid h-screen place-items-center bg-page">
        <Loader2 size={24} className="animate-spin text-t6" />
      </div>
    );
  }

  if (!isLoggedIn) {
    // Carry where they were going. Without this a reviewer who taps "Open the
    // review" in a notification email while signed out signs in and lands on
    // the inbox, having lost the one review they came for. Login validates
    // this against the same two entry allowlist the server enforces and
    // ignores anything else, so passing the pathname unconditionally is safe:
    // a /settings or /templates value simply gets dropped there.
    return (
      <Navigate to={`/login?return_to=${encodeURIComponent(pathname)}`} replace />
    );
  }

  if (user?.must_change_password) {
    return <Navigate to="/change-password" replace />;
  }

  if (
    isCloud() &&
    user?.role === "admin" &&
    pathname !== "/onboarding" &&
    !isOnboardingComplete()
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
