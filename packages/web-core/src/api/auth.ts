import { request, publicRequest } from "./client/http";

export interface Reviewer {
  id: string;
  email: string;
  name: string;
  role: string;
  last_login_at?: string;
  created_at?: string;
  must_change_password?: boolean;
  has_2fa?: boolean;
}

export interface AuthResponse {
  token?: string;
  reviewer?: Reviewer;
  must_change_password?: boolean;
  requires_2fa?: boolean;
  login_ticket?: string;
}

export async function login(
  email: string,
  password: string,
  remember: boolean = false,
  return_to?: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, remember, return_to }),
  });
}

export async function getMe(): Promise<Reviewer> {
  return request<Reviewer>("/api/v1/auth/me");
}

export async function changePassword(new_password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/api/v1/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ new_password }),
  });
}

export async function updateProfile(
  data: { name?: string; current_password?: string; new_password?: string },
): Promise<Reviewer & { token?: string }> {
  // A password change rotates the session (server revokes all others and
  // issues a fresh token), so the response carries `token` only in that
  // case — the caller must adopt it or its own next request 401s.
  return request<Reviewer & { token?: string }>("/api/v1/auth/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

/** Same-origin path to a reviewer's avatar image — GET /avatar/:id is
 *  deliberately unauthenticated (see account.ts's route doc), so this is a
 *  plain URL for `<img src>`, not a call through `request()`. */
export function avatarUrl(reviewerId: string): string {
  return `/api/v1/auth/avatar/${encodeURIComponent(reviewerId)}`;
}

export async function uploadAvatar(dataUrl: string): Promise<{ ok: true; avatar_updated_at: string }> {
  return request("/api/v1/auth/avatar", {
    method: "PUT",
    body: JSON.stringify({ data: dataUrl }),
  });
}

export async function deleteAvatar(): Promise<{ ok: true }> {
  return request("/api/v1/auth/avatar", { method: "DELETE" });
}

export const auth = {
  login,
  me: getMe,
  updateProfile,
  avatarUrl,
  uploadAvatar,
  deleteAvatar,
};

// --- Invite tokens (public, unauthenticated) ---

export interface InviteTokenInfo {
  email: string;
  role: string;
  // Who invited you, and to what — shown on the invite accept screen.
  // Null when the inviter row is gone or no project exists yet.
  inviter_name: string | null;
  team_name: string | null;
}

export async function validateInviteToken(token: string): Promise<InviteTokenInfo> {
  return publicRequest<InviteTokenInfo>(`/api/v1/auth/invite/${token}`);
}

export async function acceptInvite(
  token: string,
  data: { name: string; password: string },
): Promise<AuthResponse> {
  return publicRequest<AuthResponse>(`/api/v1/auth/invite/${token}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function logoutApi(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
}
