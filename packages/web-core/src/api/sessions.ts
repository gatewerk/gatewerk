import { request } from "./client/http";

export interface Session {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export async function listSessions(): Promise<{ items: Session[] }> {
  return request<{ items: Session[] }>("/api/v1/auth/sessions");
}

export async function revokeSession(sessionId: string): Promise<void> {
  await request("/api/v1/auth/sessions/" + sessionId, { method: "DELETE" });
}

export async function revokeAllSessions(): Promise<{ revoked_count: number }> {
  return request<{ revoked_count: number }>("/api/v1/auth/sessions/revoke-all", {
    method: "POST",
  });
}

export async function logout(): Promise<void> {
  await request("/api/v1/auth/logout", { method: "POST" });
}
