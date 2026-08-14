import { request } from "./client/http";

export interface LoginHistoryItem {
  action: string;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
  details: Record<string, unknown> | null;
}

export interface LoginHistoryResponse {
  items: LoginHistoryItem[];
  has_more: boolean;
}

export async function getLoginHistory(limit = 20, offset = 0): Promise<LoginHistoryResponse> {
  return request<LoginHistoryResponse>(
    `/api/v1/auth/login-history?limit=${limit}&offset=${offset}`,
  );
}
