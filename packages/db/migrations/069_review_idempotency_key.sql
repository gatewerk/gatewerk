ALTER TABLE reviews ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_project_id_idempotency_key_idx
  ON reviews (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
