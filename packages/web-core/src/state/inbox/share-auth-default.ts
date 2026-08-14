/**
 * Which auth tier the share modal opens on.
 *
 * A template carries `default_auth_level`, and until now web-next ignored it
 * entirely while apps/web honoured it (`pickAuthLevel`,
 * apps/web/src/pages/inbox/share-via-link-state.ts). apps/web is being
 * deleted, so without this the axis quietly stops being read at all.
 *
 * It is NOT honoured faithfully, and that asymmetry is the whole point.
 *
 * The DB default for `default_auth_level` is `public` (migration 039), so
 * every template that has never been configured claims `public` — including
 * all six on the dev stack. Seeding from it verbatim would hand a public link
 * back as the default on essentially every template in existence and silently
 * undo the choice that made `email_otp` the default precisely so a decision
 * can name the person who made it. A column default is not an operator's
 * intent.
 *
 * So the axis is read in one direction only: it may STRENGTHEN the tier, never
 * weaken it. `email_otp` and `account` are choices somebody had to make, and
 * both can name a decider, so both seed. `public`, absent, or malformed all
 * land on `email_otp` — which is also the right answer on a failed fetch, so
 * there is no path where not knowing the template makes the link weaker.
 *
 * Choosing `public` in the modal still works; it is one click, and a choice
 * made in front of the operator is a different thing from a default.
 */
export type ShareAuthLevel = "public" | "email_otp" | "account";

/** The tier a share link opens on when the template asks for nothing stronger. */
export const SHARE_AUTH_FALLBACK: ShareAuthLevel = "email_otp";

export function seedShareAuthLevel(defaultAuthLevel: unknown): ShareAuthLevel {
  if (defaultAuthLevel === "email_otp" || defaultAuthLevel === "account") {
    return defaultAuthLevel;
  }
  return SHARE_AUTH_FALLBACK;
}
