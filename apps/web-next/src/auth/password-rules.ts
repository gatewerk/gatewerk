/**
 * Password and invite rules, as pure functions.
 *
 * These live outside the components because web-next has no React render
 * harness, so anything left inline in a .tsx is untestable by construction.
 * They are also the two places the old screens got it wrong, which is the
 * better reason to be able to test them.
 *
 * The server is authoritative (apps/api/src/lib/password-policy.ts). These
 * checks exist so the form can refuse before the network does, and they must
 * not contradict it.
 */

import { PASSWORD_MAX, PASSWORD_MIN } from "./auth-copy";

export type PasswordCheck = { ok: true } | { ok: false; reason: "short" | "long" | "mismatch" };

/** Length only. Breach checking is server side and cannot be mirrored here. */
export function checkPassword(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN) return { ok: false, reason: "short" };
  if (password.length > PASSWORD_MAX) return { ok: false, reason: "long" };
  return { ok: true };
}

/** Length, then agreement between the two fields. Order matters: a short
 *  password that also fails to match should be reported as short, because that
 *  is the one the reviewer has to fix first. */
export function checkPasswordPair(password: string, confirm: string): PasswordCheck {
  const base = checkPassword(password);
  if (!base.ok) return base;
  if (password !== confirm) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** Whether the submit button may be enabled at all. */
export function canSubmitPassword(password: string, confirm?: string): boolean {
  if (confirm === undefined) return checkPassword(password).ok;
  return checkPasswordPair(password, confirm).ok;
}

export type InviteState = "ready" | "expired" | "used" | "invalid" | "error";

/**
 * Map a validateInviteToken rejection onto a page state.
 *
 * The API signals "used" and "expired" only in the message text, so this
 * matches on it. A 404 is a token that never existed. Anything else is our
 * problem, not the reviewer's, and says so.
 */
export function inviteStateFromError(err: unknown): Exclude<InviteState, "ready"> {
  const message = err instanceof Error ? err.message : "";
  const status = (err as { status?: number } | null | undefined)?.status;
  if (message.includes("already been used")) return "used";
  if (message.includes("expired")) return "expired";
  if (status === 404) return "invalid";
  return "error";
}
