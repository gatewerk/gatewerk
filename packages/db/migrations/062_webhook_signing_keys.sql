-- Webhook signing key rotation table.
-- Purely additive infrastructure for FUTURE multi-key rotation flows. The
-- current dispatch path (apps/api/src/services/webhook-retry-worker.ts) still
-- uses the Block 6 revised F5 contract: single CURRENT projects.hmac_secret
-- re-read at retry time. This table will be wired in by a follow-up PR once
-- the rotation flow is designed end-to-end.
--
-- `status` values: 'active' (current key), 'previous' (24h overlap), 'revoked' (expired).
-- Idempotent: safe to re-apply.
CREATE TABLE IF NOT EXISTS webhook_signing_keys (
  id           TEXT        PRIMARY KEY,
  project_id   TEXT        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_id       TEXT        NOT NULL,
  secret       TEXT        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('active', 'previous', 'revoked')),
  rotated_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_signing_keys_project_status_idx
  ON webhook_signing_keys (project_id, status);

-- Unique constraint: one active key per project at any time
CREATE UNIQUE INDEX IF NOT EXISTS webhook_signing_keys_project_active_idx
  ON webhook_signing_keys (project_id)
  WHERE status = 'active';

-- Prevent key_id reuse across statuses (e.g., active row + revoked row with same key_id).
-- Without this, rotation history is ambiguous when keys are recycled.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_signing_keys_project_key_idx
  ON webhook_signing_keys (project_id, key_id);

-- NOTE for the future rotation-flow PR: the partial unique index above means
-- the documented "mark old as 'previous' then insert new 'active'" sequence
-- MUST run inside a single transaction. A non-transactional flow would
-- transiently violate the unique constraint and fail. Block 6's
-- single-secret-at-retry dispatch path is unaffected because it does not
-- query this table at all.
