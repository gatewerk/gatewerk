-- 065 — extend cloud_subscriptions.plan CHECK to include the 3-SKU tiers.
-- Migration 047 set the constraint to ('trial','solo'); Lane E writes
-- ('team','business','community'). Without this, the first successful
-- checkout webhook throws Postgres 23514 and Stripe retries indefinitely.
-- Idempotent via DROP IF EXISTS + ADD.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cloud_subscriptions_plan_check'
  ) THEN
    ALTER TABLE cloud_subscriptions DROP CONSTRAINT cloud_subscriptions_plan_check;
  END IF;
  ALTER TABLE cloud_subscriptions
    ADD CONSTRAINT cloud_subscriptions_plan_check
    CHECK (plan IN ('trial', 'solo', 'community', 'team', 'business'));
END$$;
