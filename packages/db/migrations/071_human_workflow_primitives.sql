ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS held_by TEXT,
  ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS reviews_held_by_idx ON reviews (held_by) WHERE held_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS reviews_snoozed_until_idx ON reviews (snoozed_until) WHERE snoozed_until IS NOT NULL;
