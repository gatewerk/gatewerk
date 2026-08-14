import { request, publicRequest } from "./client/http";

export async function forgotPassword(email: string): Promise<{ ok: boolean }> {
  return publicRequest<{ ok: boolean }>("/api/v1/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(
  token: string,
  new_password: string,
): Promise<{ ok: boolean }> {
  return publicRequest<{ ok: boolean }>("/api/v1/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, new_password }),
  });
}

// Which credential DELETE /account will ask for. Cloud accounts created with
// Google or GitHub have no password in any store, so the form cannot assume a
// password field exists to fill in.
export type DeletionChallenge = "password" | "email_confirmation";

export async function getDeletionChallenge(): Promise<{ method: DeletionChallenge }> {
  return request<{ method: DeletionChallenge }>("/api/v1/auth/account/deletion-challenge");
}

export async function deleteAccount(
  credential: { current_password: string } | { confirm_email: string },
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/v1/auth/account", {
    method: "DELETE",
    body: JSON.stringify(credential),
  });
}

export async function updatePreferences(prefs: {
  login_notifications: boolean;
}): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/v1/auth/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs),
  });
}
