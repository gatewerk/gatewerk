-- Migration 060: WebAuthn / Passkey credentials
-- Stores public-key credentials per reviewer for phishing-resistant login.
-- Each row is one authenticator registration (device, security key, etc.).
-- A reviewer may have multiple credentials.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id              TEXT PRIMARY KEY,                          -- internal PK (gw_pkey_*)
  user_id         TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  credential_id   TEXT NOT NULL UNIQUE,                      -- WebAuthn-spec credentialID (base64url)
  public_key      BYTEA NOT NULL,                            -- COSE-encoded public key bytes
  counter         BIGINT NOT NULL DEFAULT 0,                 -- authenticator counter; monotonic per credential
  transports      TEXT[],                                    -- usb/nfc/ble/internal/hybrid
  aaguid          TEXT,                                      -- authenticator model identifier
  friendly_name   TEXT NOT NULL DEFAULT '',                  -- user-assigned nickname
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_credential
  ON webauthn_credentials (user_id, credential_id);
