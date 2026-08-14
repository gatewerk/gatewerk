-- Wave 4: dunning tracking column on cloud_subscriptions + account tombstones table

ALTER TABLE cloud_subscriptions
ADD COLUMN IF NOT EXISTS last_dunning_sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS account_tombstones (
  id                      TEXT PRIMARY KEY,
  deleted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  signup_cohort           DATE NOT NULL,
  churn_cohort            DATE NOT NULL,
  plan_at_churn           TEXT NOT NULL,
  mrr_cents               INTEGER NOT NULL DEFAULT 0,
  ltv_cents               INTEGER NOT NULL DEFAULT 0,
  trial_converted         BOOLEAN NOT NULL,
  trial_days              SMALLINT,
  account_age_days        INTEGER NOT NULL,
  reviews_created         INTEGER NOT NULL DEFAULT 0,
  api_calls_total         BIGINT NOT NULL DEFAULT 0,
  templates_created       INTEGER NOT NULL DEFAULT 0,
  tokens_generated        INTEGER NOT NULL DEFAULT 0,
  completed_onboarding    BOOLEAN NOT NULL DEFAULT false,
  reached_first_review    BOOLEAN NOT NULL DEFAULT false,
  reached_first_approval  BOOLEAN NOT NULL DEFAULT false,
  upgraded_from_trial     BOOLEAN NOT NULL DEFAULT false,
  deletion_reason         TEXT NOT NULL
);
