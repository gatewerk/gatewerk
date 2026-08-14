import { InvalidRequestError } from "@gatewerk/shared";
import { verifyPassword } from "../services/auth/password";

/**
 * How an account proves it means to delete itself.
 *
 * Two auth paths reach DELETE /account. Self-host reviewers, and Cloud members
 * who joined by accepting an invite, hold a real hash in
 * reviewers.password_hash. Cloud users who signed up through Supabase hold the
 * literal sentinel "supabase_managed" there (ee/auth/provision.ts), which can
 * never verify against any input — so before this split, every Cloud signup got
 * "Current password is incorrect" and had no way to erase their account at all.
 *
 * The split is per-row, on supabase_user_id, not per-deployment on
 * config.mode: a cloud-mode deployment genuinely hosts both kinds of reviewer,
 * because /api/v1/auth/invite is mounted unconditionally and writes a real
 * hash with supabase_user_id left null.
 */
export type DeletionChallenge = "password" | "email_confirmation";

export interface DeletionCredentialSubject {
  id: string;
  email: string;
  password_hash: string;
  supabase_user_id: string | null;
}

interface CloudDeletionModule {
  getCloudDeletionChallenge(supabaseUserId: string): Promise<DeletionChallenge>;
  verifyCloudPassword(email: string, password: string): Promise<boolean>;
  deleteCloudAuthUser(supabaseUserId: string): Promise<void>;
}

// Indirected through a function so the bundler cannot statically resolve it.
// The target lives in the private ./ee submodule, which the OSS image never
// copies, and this module is only ever reached when supabase_user_id is set,
// which OSS never writes.
//
// Absolute rather than a bare relative string: see mountEeIfCloud in app.ts for
// why every one of these seams has to be built from import.meta.url.
export async function loadCloudDeletion(): Promise<CloudDeletionModule> {
  const path = (): string => new URL("../../../../ee/api/auth/account-deletion.js", import.meta.url).href;
  return (await import(path())) as CloudDeletionModule;
}

function missingPassword(): never {
  throw new InvalidRequestError(
    "current_password is required",
    "current_password",
    "missing_current_password",
  );
}

function incorrectPassword(): never {
  throw new InvalidRequestError(
    "Current password is incorrect",
    "current_password",
    "incorrect_password",
  );
}

/**
 * Which credential this account must supply. Lets the UI render the right
 * field instead of asking an OAuth-only user for a password that does not
 * exist. Throws if Supabase cannot be reached, rather than falling back to the
 * weaker challenge.
 */
export async function resolveDeletionChallenge(
  reviewer: Pick<DeletionCredentialSubject, "supabase_user_id">,
): Promise<DeletionChallenge> {
  if (!reviewer.supabase_user_id) return "password";
  const ee = await loadCloudDeletion();
  return ee.getCloudDeletionChallenge(reviewer.supabase_user_id);
}

/**
 * Verifies the deletion credential, throwing the same error shape for both
 * auth paths. The password-authenticated branch is byte-for-byte the check
 * that was already here — the Cloud branch is added alongside it, not in place
 * of it.
 */
export async function assertDeletionCredential(
  reviewer: DeletionCredentialSubject,
  body: { current_password?: unknown; confirm_email?: unknown },
): Promise<void> {
  if (!reviewer.supabase_user_id) {
    const password = body.current_password;
    if (!password || typeof password !== "string") missingPassword();
    const { valid } = await verifyPassword(reviewer.password_hash, password);
    if (!valid) incorrectPassword();
    return;
  }

  const ee = await loadCloudDeletion();
  const challenge = await ee.getCloudDeletionChallenge(reviewer.supabase_user_id);

  if (challenge === "password") {
    const password = body.current_password;
    if (!password || typeof password !== "string") missingPassword();
    // Same credential, checked against the store that actually holds it.
    const valid = await ee.verifyCloudPassword(reviewer.email, password);
    if (!valid) incorrectPassword();
    return;
  }

  // OAuth-only: no password exists in either store. The request already
  // carries a live Supabase session; typing the account's own address is the
  // deliberate confirmation on top of it.
  const confirmEmail = body.confirm_email;
  if (!confirmEmail || typeof confirmEmail !== "string") {
    throw new InvalidRequestError(
      "confirm_email is required for accounts that sign in with a provider",
      "confirm_email",
      "missing_confirm_email",
    );
  }
  if (confirmEmail.trim().toLowerCase() !== reviewer.email.trim().toLowerCase()) {
    throw new InvalidRequestError(
      "That is not this account's email address",
      "confirm_email",
      "confirm_email_mismatch",
    );
  }
}
