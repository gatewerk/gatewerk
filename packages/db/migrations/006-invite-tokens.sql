-- Invite tokens for invite-only user registration
CREATE TABLE IF NOT EXISTS invite_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'reviewer',
  invited_by text NOT NULL REFERENCES reviewers(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invite_tokens_token_hash_idx ON invite_tokens(token_hash);
CREATE INDEX IF NOT EXISTS invite_tokens_email_idx ON invite_tokens(email);
