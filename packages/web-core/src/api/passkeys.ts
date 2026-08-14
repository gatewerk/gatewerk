import { request } from "./client/http";

export interface PasskeyCredential {
  id: string;
  friendly_name: string;
  transports: string[] | null;
  created_at: string;
  last_used_at: string | null;
}

export async function listPasskeys(): Promise<{ items: PasskeyCredential[]; total: number }> {
  return request<{ items: PasskeyCredential[]; total: number }>("/api/v1/account/passkeys");
}

export async function deletePasskey(id: string): Promise<void> {
  await request(`/api/v1/account/passkeys/${id}`, { method: "DELETE" });
}

export async function registerPasskey(friendly_name: string): Promise<{ verified: boolean; id: string }> {
  // Lazy-load @simplewebauthn/browser to keep the eager bundle slim
  const { startRegistration } = await import("@simplewebauthn/browser");

  // Step 1: Get options from server
  const opts = await request<any>("/api/v1/auth/passkey/register/options", {
    method: "POST",
    body: JSON.stringify({ friendly_name }),
  });
  const { _challenge_key, _friendly_name: _fn, ...credentialCreationOptions } = opts;

  // Step 2: Call browser WebAuthn API (prompts user for authenticator)
  const response = await startRegistration({ optionsJSON: credentialCreationOptions });

  // Step 3: Verify with server
  return request<{ verified: boolean; id: string }>("/api/v1/auth/passkey/register/verify", {
    method: "POST",
    body: JSON.stringify({ _challenge_key, response, friendly_name }),
  });
}
