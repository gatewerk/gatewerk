/**
 * Whether the admin has finished (or dismissed) the activation wizard.
 *
 * Ported in behaviour from apps/web/src/pages/onboarding/onboarding-store.ts.
 * The localStorage key is UNCHANGED on purpose: an admin who already completed
 * onboarding in apps/web must not be handed the wizard again the first time
 * they load web-next after the cutover.
 *
 * Every access is guarded, which apps/web's version is not, because web-next is
 * a different kind of app in two ways that both bite here:
 *
 *   1. It prerenders. `isOnboardingComplete()` is read during RENDER by
 *      RequireAuth's first-run redirect, so an unguarded read is a build
 *      failure at the CI gate, not a runtime hiccup.
 *   2. Storage can be denied outright (Safari private browsing, an embedded
 *      webview, a locked-down profile). Failing closed there means "not
 *      complete", which shows the wizard again — mildly annoying. Throwing
 *      means a white screen on every authenticated route. The tradeoff is not
 *      close.
 */

const KEY = "gatewerk_onboarding_complete";

/**
 * Set whenever this tab finishes or skips onboarding, whether or not the write
 * to storage landed.
 *
 * Without it, a blocked write is a LOCKOUT rather than an annoyance, because
 * RequireAuth redirects a cloud admin to /onboarding on every authenticated
 * route while the flag reads false. Skip would write nothing, navigate to the
 * inbox, and be redirected straight back — the wizard with no exit that this
 * whole flow exists to avoid. Failing closed is only safe when something else
 * remembers, so this is that something, for as long as the tab lives.
 */
let completedThisSession = false;

export function isOnboardingComplete(): boolean {
  if (completedThisSession) return true;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  completedThisSession = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Storage is denied. The in-memory flag above carries the decision for this
    // tab; the only cost is being offered onboarding again next session.
  }
}

export function clearOnboardingComplete(): void {
  // Clears the in-memory flag too, or replaying from Settings in a
  // storage-denied session would do nothing.
  completedThisSession = false;
  localStorage.removeItem(KEY);
}

/**
 * Replay: forget the flag so the wizard runs again. Unlike the setters this one
 * reports failure, because it is a button the user pressed and nothing visible
 * would otherwise happen.
 */
export function replayOnboarding(): { ok: boolean; reason?: "storage-blocked" } {
  try {
    clearOnboardingComplete();
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage-blocked" };
  }
}
