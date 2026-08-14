import { request, publicRequest } from "./client/http";

export interface TwoFactorSetupResponse {
  uri: string;
  base32: string;
  qr_data_url: string;
}

export interface TwoFactorVerifyResponse {
  backup_codes: string[];
}

export interface TwoFactorValidateResponse {
  token: string;
  reviewer: {
    id: string;
    email: string;
    name: string;
    role: string;
    must_change_password?: boolean;
    has_2fa?: boolean;
  };
  must_change_password?: boolean;
}

export async function setup2FA(): Promise<TwoFactorSetupResponse> {
  return request<TwoFactorSetupResponse>("/api/v1/auth/2fa/setup", { method: "POST" });
}

export async function verifySetup2FA(code: string): Promise<TwoFactorVerifyResponse> {
  return request<TwoFactorVerifyResponse>("/api/v1/auth/2fa/verify-setup", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function disable2FA(current_password: string): Promise<void> {
  await request("/api/v1/auth/2fa", {
    method: "DELETE",
    body: JSON.stringify({ current_password }),
  });
}

export async function regenerateBackupCodes(current_password: string): Promise<TwoFactorVerifyResponse> {
  return request<TwoFactorVerifyResponse>("/api/v1/auth/2fa/backup-codes", {
    method: "POST",
    body: JSON.stringify({ current_password }),
  });
}

export async function validate2FA(login_ticket: string, code: string): Promise<TwoFactorValidateResponse> {
  return publicRequest<TwoFactorValidateResponse>("/api/v1/auth/2fa/validate", {
    method: "POST",
    body: JSON.stringify({ login_ticket, code }),
  });
}
