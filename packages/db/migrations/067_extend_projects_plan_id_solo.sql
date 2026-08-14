-- 067 — extend chk_projects_plan_id to include 'solo' (4th first-class tier).
-- Migration 064 created the constraint with ('community','team','business').
-- Lane E holistic remediation: Solo SKU is retained as a legacy first-class
-- tier so existing Cloud Solo Wave 1 customers continue to work. New signups
-- cannot select solo (UI filters it out) but webhook plan derivation must be
-- allowed to write 'solo' when an existing subscription's stripe_price_id
-- maps to STRIPE_PRICE_ID_SOLO. Idempotent: drop + add.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_plan_id'
  ) THEN
    ALTER TABLE projects DROP CONSTRAINT chk_projects_plan_id;
  END IF;
  ALTER TABLE projects
    ADD CONSTRAINT chk_projects_plan_id
    CHECK (plan_id IN ('community', 'solo', 'team', 'business'));
END$$;
