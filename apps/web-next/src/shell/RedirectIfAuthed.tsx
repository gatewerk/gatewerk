/**
 * RedirectIfAuthed — the inverse of RequireAuth, for the public signup page.
 *
 * Cosmetically it saves a returning user from staring at a signup form. The
 * real reason it exists is that the cloud signup page is destructive to an
 * existing session: `supabase.auth.signUp` swaps the Supabase session for the
 * new account's, while CloudAuthProvider's `user` state does not react to
 * SIGNED_IN. The window is a signed-in user who lands on /signup and completes
 * it — the shell keeps rendering account A while `setCloudTokenGetter` hands
 * every API call account B's token. Nothing errors; the user is simply acting
 * on someone else's workspace.
 *
 * Waits out isLoading first so the form does not flash before the redirect.
 *
 * Mirrors apps/web/src/catchall.tsx's RedirectIfAuthed. Applied only to the
 * cloud /signup route: web-next's /login has never had this wrapper, and
 * changing that is a separate decision from the one this file exists to make.
 */

import { Navigate } from "react-router";
import { Loader2 } from "lucide-react";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";

export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="grid h-screen place-items-center bg-page">
        <Loader2 size={24} className="animate-spin text-t6" />
      </div>
    );
  }

  if (isLoggedIn) return <Navigate to="/" replace />;

  return <>{children}</>;
}
