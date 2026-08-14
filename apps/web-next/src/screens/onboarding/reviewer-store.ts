/**
 * Whether this reviewer has been through the sample walkthrough.
 *
 * A separate key from the admin wizard's on purpose (handoff §E): the two
 * flows teach different people different things, and an admin who dismissed
 * the activation wizard has not thereby learned what a decision means. Sharing
 * one flag would silently skip one persona's onboarding based on the other's.
 *
 * `gw-` prefix rather than `gatewerk_`: web-core owns the `gatewerk_*`
 * namespace (the auth token, the theme), app-local state uses `gw-`.
 *
 * Guarded like onboarding-store, and for the same reason — this is read during
 * render and web-next prerenders.
 */

const KEY = "gw-reviewer-onboarding-complete";

export function isReviewerOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markReviewerOnboardingComplete(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // The reviewer asked to leave the walkthrough; being offered it again next
    // session is a smaller cost than refusing to let them out of it.
  }
}

export function replayReviewerOnboarding(): { ok: boolean; reason?: "storage-blocked" } {
  try {
    localStorage.removeItem(KEY);
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage-blocked" };
  }
}
