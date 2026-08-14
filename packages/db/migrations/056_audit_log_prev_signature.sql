-- Introduce HMAC chain columns for tamper-evident audit_log.
--
-- v2 rows store the previous row's signature per project_id partition, making
-- deletion detectable: a gap in the chain breaks the prev_signature link.
-- v1 rows (signature_version = 1, the DEFAULT) keep the legacy single-row
-- signature; the verifier handles them with the original input format.
--
-- Both columns are additive, fully backwards-compatible, and idempotent per
-- project convention (IF NOT EXISTS everywhere).

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_signature text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS signature_version smallint NOT NULL DEFAULT 1;

-- Chain-walk index: used by the verify() query to walk rows in insertion order
-- within a project_id partition (NULL for system rows).
CREATE INDEX IF NOT EXISTS idx_audit_log_chain_order
  ON audit_log (project_id, created_at, id);
