import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@gatewerk/db/src/schema/index";
import { projects, apiKeys, reviewers } from "@gatewerk/db/src/schema/index";
import { createHash } from "crypto";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Express } from "express";

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await client.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      cloud_config JSONB,
      stripe_customer_id TEXT UNIQUE,
      billing_email TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      email_paused_at TIMESTAMPTZ,
      email_pause_reason TEXT,
      email_resumed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      webhook_url TEXT,
      hmac_secret TEXT NOT NULL,
      organization_id TEXT REFERENCES organizations(id),
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      plan_id TEXT NOT NULL DEFAULT 'community',
      entitlements_override JSONB,
      trial_ends_at TIMESTAMPTZ,
      seat_count INTEGER NOT NULL DEFAULT 1,
      CONSTRAINT chk_projects_plan_id CHECK (plan_id IN ('community', 'solo', 'team', 'business'))
    );
    CREATE INDEX IF NOT EXISTS idx_projects_plan_id ON projects(plan_id);
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      label TEXT,
      scopes JSONB NOT NULL,
      is_active BOOLEAN DEFAULT TRUE NOT NULL,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      name TEXT,
      description TEXT,
      callback_url TEXT,
      default_reviewer TEXT,
      rate_limit_per_hour INTEGER,
      template_ids JSONB,
      expires_at TIMESTAMPTZ,
      ip_allowlist JSONB
    );
    CREATE TABLE IF NOT EXISTS api_key_usage (
      id BIGSERIAL PRIMARY KEY,
      api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS api_key_usage_lookup
      ON api_key_usage (api_key_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      fields JSONB NOT NULL,
      actions JSONB NOT NULL DEFAULT '["approve","reject"]',
      default_priority TEXT NOT NULL DEFAULT 'normal',
      enable_review_links BOOLEAN NOT NULL DEFAULT FALSE,
      auto_approve BOOLEAN NOT NULL DEFAULT FALSE,
      timeout_seconds INTEGER,
      timeout_action TEXT,
      changes_timeout_hours INTEGER,
      instructions TEXT,
      allow_request_changes BOOLEAN NOT NULL DEFAULT TRUE,
      allow_notes BOOLEAN NOT NULL DEFAULT TRUE,
      allow_monitoring BOOLEAN NOT NULL DEFAULT FALSE,
      default_auth_level TEXT NOT NULL DEFAULT 'public' CHECK (default_auth_level IN ('public', 'email_otp', 'account')),
      default_expiry_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (default_expiry_seconds > 0 AND default_expiry_seconds <= 2592000),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'inactive')),
      draft_config JSONB,
      draft_updated_at TIMESTAMPTZ,
      chain_config JSONB,
      max_iterations INTEGER CHECK (max_iterations IS NULL OR max_iterations >= 1),
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    -- Migration 055 / schema/templates.ts. Missing here until S1 (2026-07-29),
    -- which meant no test could reach the 23505 -> slug_already_exists
    -- translation on either POST /templates or publish(): the harness let
    -- duplicate slugs insert cleanly, so both branches were unreachable in CI
    -- while firing in production.
    CREATE UNIQUE INDEX IF NOT EXISTS templates_project_id_slug_uniq
      ON templates (project_id, slug);
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
      template_slug TEXT NOT NULL,
      payload JSONB NOT NULL,
      suggested_value JSONB,
      approved_value JSONB,
      callback_url TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
      actions JSONB NOT NULL DEFAULT '["approve","reject"]',
      confidence REAL,
      irreversibility TEXT,
      oversight TEXT NOT NULL DEFAULT 'blocking' CHECK (oversight IN ('blocking', 'monitoring')),
      assignee TEXT,
      metadata JSONB,
      timeout_action TEXT,
      timeout_seconds INTEGER,
      expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived', 'monitoring')),
      decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'edited', 'retried', 'expired', 'max_iterations_reached', 'confirmed', 'vetoed')),
      edited_payload JSONB,
      feedback TEXT,
      prompt_edit TEXT,
      decided_by TEXT,
      decided_by_verified BOOLEAN,
      decided_at TIMESTAMPTZ,
      last_action_id TEXT,
      last_action_kind TEXT CHECK (last_action_kind IS NULL OR last_action_kind IN ('decision', 'iteration', 'side_effect')),
      last_action_at TIMESTAMPTZ,
      last_action_by TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      draft_payload JSONB,
      draft_by TEXT,
      draft_at TIMESTAMPTZ,
      held_by TEXT,
      held_at TIMESTAMPTZ,
      snoozed_until TIMESTAMPTZ,
      action_value TEXT,
      action_label TEXT,
      assignment_ladder JSONB,
      ladder_index INTEGER NOT NULL DEFAULT 0,
      ladder_next_promote_at TIMESTAMPTZ,
      chain_run_id TEXT,
      chain_step_id TEXT,
      prev_step_ids JSONB,
      idempotency_key TEXT,
      trace_url TEXT CHECK (trace_url IS NULL OR trace_url LIKE 'https://%'),
      max_iterations INTEGER CHECK (max_iterations IS NULL OR max_iterations >= 1),
      template_fields JSONB,
      reminder_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_project_id_idempotency_key_idx
      ON reviews (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS reviews_ladder_next_promote_at_idx
      ON reviews (ladder_next_promote_at) WHERE ladder_next_promote_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS reviews_chain_run_id_idx
      ON reviews (chain_run_id) WHERE chain_run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS reviews_held_by_idx
      ON reviews (held_by) WHERE held_by IS NOT NULL;
    CREATE INDEX IF NOT EXISTS reviews_snoozed_until_idx
      ON reviews (snoozed_until) WHERE snoozed_until IS NOT NULL;
    CREATE TABLE IF NOT EXISTS chain_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
      name TEXT,
      mode TEXT NOT NULL DEFAULT 'sequential',
      rejection_policy TEXT NOT NULL DEFAULT 'terminate',
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS chain_runs_project_id_idx
      ON chain_runs (project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS chain_runs_active_idx
      ON chain_runs (project_id, created_at DESC) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS chain_steps (
      id TEXT PRIMARY KEY,
      chain_run_id TEXT NOT NULL REFERENCES chain_runs(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      review_id TEXT REFERENCES reviews(id) ON DELETE SET NULL,
      assignee_spec JSONB NOT NULL,
      depends_on JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      materialized_at TIMESTAMPTZ,
      rejection_policy TEXT,
      rejection_branch_to INTEGER,
      UNIQUE (chain_run_id, step_number),
      CONSTRAINT chain_steps_rejection_policy_values_chk CHECK (
        rejection_policy IS NULL
        OR rejection_policy IN ('abort', 'continue', 'branch')
      ),
      CONSTRAINT chain_steps_rejection_branch_to_chk CHECK (
        (rejection_policy <> 'branch' AND rejection_branch_to IS NULL)
        OR (
          rejection_policy = 'branch'
          AND rejection_branch_to IS NOT NULL
          AND rejection_branch_to > 0
          AND rejection_branch_to < step_number
        )
      )
    );
    CREATE INDEX IF NOT EXISTS chain_steps_chain_run_id_idx
      ON chain_steps (chain_run_id, step_number);
    CREATE TABLE IF NOT EXISTS review_versions (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      payload JSONB NOT NULL,
      feedback TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviewers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer')),
      is_active BOOLEAN DEFAULT TRUE NOT NULL,
      must_change_password BOOLEAN DEFAULT FALSE NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 0,
      last_login_at TIMESTAMPTZ,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      totp_secret_encrypted TEXT,
      totp_enabled_at TIMESTAMPTZ,
      totp_backup_codes JSONB,
      last_used_totp_at TIMESTAMPTZ,
      email_verified_at TIMESTAMPTZ,
      password_reset_token_hash TEXT,
      password_reset_expires_at TIMESTAMPTZ,
      login_notifications BOOLEAN NOT NULL DEFAULT TRUE,
      supabase_user_id TEXT UNIQUE,
      avatar_data BYTEA,
      avatar_content_type TEXT,
      avatar_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organization_memberships (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(organization_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS org_memberships_org_idx ON organization_memberships(organization_id);
    CREATE INDEX IF NOT EXISTS org_memberships_user_idx ON organization_memberships(user_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details JSONB,
      signature TEXT,
      prev_signature TEXT,
      signature_version SMALLINT NOT NULL DEFAULT 1,
      project_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_log_project_id_idx ON audit_log (project_id);
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      events JSONB NOT NULL,
      headers JSONB,
      is_active BOOLEAN DEFAULT TRUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      last_delivery_at TIMESTAMPTZ,
      last_delivery_status TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      url TEXT NOT NULL,
      payload JSONB NOT NULL,
      -- hmac_secret column dropped in migration 057 (Block 6 C1, 2026-05-18)
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      last_attempt_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      decision TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      recipient_label TEXT NOT NULL,
      note TEXT,
      auth_level TEXT NOT NULL DEFAULT 'public' CHECK (auth_level IN ('public', 'email_otp', 'account')),
      auth_email TEXT,
      auth_user_id TEXT,
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('manual', 'chain', 'agent')),
      created_by_id TEXT NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT,
      decided_by_email TEXT,
      decided_by_user_id TEXT,
      is_preview BOOLEAN NOT NULL DEFAULT FALSE,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      otp_locked_until TIMESTAMPTZ,
      CONSTRAINT review_tokens_account_requires_user_id_chk
        CHECK (auth_level <> 'account' OR auth_user_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS review_tokens_token_hash_idx ON review_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS review_tokens_review_id_idx ON review_tokens(review_id);
    CREATE INDEX IF NOT EXISTS review_tokens_review_id_created_at_idx ON review_tokens(review_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS review_tokens_project_id_expires_at_idx ON review_tokens(project_id, expires_at);
    CREATE TABLE IF NOT EXISTS email_otp_codes (
      id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL REFERENCES review_tokens(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS email_otp_codes_token_id_idx ON email_otp_codes(token_id);
    CREATE TABLE IF NOT EXISTS review_notes (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS review_notes_review_id_idx ON review_notes(review_id);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id TEXT,
      author_display_fallback TEXT,
      body TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      is_shared BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      CONSTRAINT notes_author_present CHECK (
        author_id IS NOT NULL OR author_display_fallback IS NOT NULL
      )
    );
    CREATE INDEX IF NOT EXISTS notes_project_shared_idx
      ON notes(project_id, is_shared, created_at DESC);
    CREATE INDEX IF NOT EXISTS notes_author_idx
      ON notes(project_id, author_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS note_attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('review', 'template', 'chain_run')),
      target_id TEXT NOT NULL,
      attached_by TEXT,
      attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (note_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS note_attachments_target_idx
      ON note_attachments(target_kind, target_id);
    CREATE INDEX IF NOT EXISTS note_attachments_note_idx
      ON note_attachments(note_id);
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reviewer',
      invited_by TEXT NOT NULL REFERENCES reviewers(id),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS invite_tokens_token_hash_idx ON invite_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS invite_tokens_email_idx ON invite_tokens(email);
    CREATE TABLE IF NOT EXISTS sessions (
      id             TEXT PRIMARY KEY,
      reviewer_id    TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
      jti            TEXT NOT NULL UNIQUE,
      ip_address     TEXT,
      user_agent     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at     TIMESTAMPTZ NOT NULL,
      revoked_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_reviewer_active
      ON sessions (reviewer_id) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_jti
      ON sessions (jti) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS cloud_subscriptions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_subscription_id TEXT UNIQUE,
      stripe_price_id TEXT,
      plan TEXT NOT NULL CHECK (plan IN ('trial', 'solo', 'community', 'team', 'business')),
      status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
      trial_ends_at TIMESTAMPTZ,
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      cancel_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      last_event_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_dunning_sent_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      counted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB
    );
    CREATE TABLE IF NOT EXISTS account_tombstones (
      id TEXT PRIMARY KEY,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      signup_cohort DATE NOT NULL,
      churn_cohort DATE NOT NULL,
      plan_at_churn TEXT NOT NULL,
      mrr_cents INTEGER NOT NULL DEFAULT 0,
      ltv_cents INTEGER NOT NULL DEFAULT 0,
      trial_converted BOOLEAN NOT NULL,
      trial_days SMALLINT,
      account_age_days INTEGER NOT NULL,
      reviews_created INTEGER NOT NULL DEFAULT 0,
      api_calls_total BIGINT NOT NULL DEFAULT 0,
      templates_created INTEGER NOT NULL DEFAULT 0,
      tokens_generated INTEGER NOT NULL DEFAULT 0,
      completed_onboarding BOOLEAN NOT NULL DEFAULT false,
      reached_first_review BOOLEAN NOT NULL DEFAULT false,
      reached_first_approval BOOLEAN NOT NULL DEFAULT false,
      upgraded_from_trial BOOLEAN NOT NULL DEFAULT false,
      deletion_reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_daily_rollups (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      rollup_date DATE NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(organization_id, event_type, rollup_date)
    );
    CREATE INDEX IF NOT EXISTS usage_daily_rollups_org_date_idx
      ON usage_daily_rollups(organization_id, rollup_date);
    CREATE TABLE IF NOT EXISTS jobs_daily_digest_state (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      last_run_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    INSERT INTO jobs_daily_digest_state (id, last_run_at)
      VALUES ('singleton', '1970-01-01T00:00:00Z')
      ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS jobs_notification_digest_state (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      last_run_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'
    );
    INSERT INTO jobs_notification_digest_state (id, last_run_at)
      VALUES ('singleton', '1970-01-01T00:00:00Z')
      ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
      credential_id   TEXT NOT NULL UNIQUE,
      public_key      BYTEA NOT NULL,
      counter         BIGINT NOT NULL DEFAULT 0,
      transports      TEXT[],
      aaguid          TEXT,
      friendly_name   TEXT NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_credential
      ON webauthn_credentials (user_id, credential_id);
    CREATE TABLE IF NOT EXISTS meter_event_queue (
      id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      value NUMERIC NOT NULL,
      event_timestamp TIMESTAMPTZ NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed'))
    );
    CREATE INDEX IF NOT EXISTS idx_meter_event_queue_pending ON meter_event_queue(status) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS notifications (
      id           TEXT PRIMARY KEY,
      reviewer_id  TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
      review_id    TEXT REFERENCES reviews(id) ON DELETE CASCADE,
      event        TEXT NOT NULL,
      category     TEXT NOT NULL,
      title        TEXT NOT NULL,
      dedup_key    TEXT NOT NULL,
      read_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS notifications_reviewer_id_created_at_idx ON notifications (reviewer_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_key_idx ON notifications (dedup_key);
    CREATE TABLE IF NOT EXISTS notification_preferences (
      reviewer_id TEXT PRIMARY KEY REFERENCES reviewers(id) ON DELETE CASCADE,
      prefs       JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notification_suppressions (
      id         TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      reason     TEXT NOT NULL,
      metadata   JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS notification_suppressions_address_idx ON notification_suppressions (address);
    CREATE TABLE IF NOT EXISTS slack_workspaces (
      id                       TEXT PRIMARY KEY,
      organization_id          TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      team_id                  TEXT NOT NULL,
      team_name                TEXT,
      bot_token_encrypted      TEXT NOT NULL,
      bot_user_id              TEXT,
      installed_by_reviewer_id TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      revoked_at               TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS slack_workspaces_team_id_idx ON slack_workspaces (team_id);
    CREATE TABLE IF NOT EXISTS slack_user_links (
      reviewer_id      TEXT PRIMARY KEY REFERENCES reviewers(id) ON DELETE CASCADE,
      slack_user_id    TEXT NOT NULL,
      slack_team_id    TEXT NOT NULL,
      cached_at        TIMESTAMPTZ DEFAULT NOW(),
      lookup_failed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS email_sends (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      is_transactional BOOLEAN NOT NULL DEFAULT TRUE,
      bounced_at TIMESTAMPTZ,
      complained_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notification_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS email_sends_message_id_idx ON email_sends (message_id);
    CREATE INDEX IF NOT EXISTS email_sends_org_created_at_idx ON email_sends (organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS email_sends_address_created_at_idx ON email_sends (address, created_at DESC);
    CREATE INDEX IF NOT EXISTS email_sends_notification_id_idx ON email_sends (notification_id);
    CREATE TABLE IF NOT EXISTS product_feedback (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      subject    TEXT NOT NULL,
      message    TEXT NOT NULL,
      context    JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS product_feedback_subject_created_idx
      ON product_feedback (subject, created_at);
  `);

  return { db, client };
}

export async function seedTestProject(db: any) {
  const rawKey = "gwk_test1234567890abcdef";
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const [project] = await db.insert(projects).values({
    id: generateId("project"),
    name: "Test Project",
    hmac_secret: "test-hmac-secret",
  }).returning();

  await db.insert(apiKeys).values({
    id: generateId("api_key"),
    project_id: project.id,
    key_hash: keyHash,
    key_prefix: "gwk_test1",
    label: "Test key",
    scopes: [...ALL_SCOPES],
  });

  return { project, apiKey: rawKey };
}

export async function seedReviewer(
  db: any,
  app: Express,
  opts: { email: string; password?: string; role?: string; name?: string },
): Promise<{ reviewer: any; sessionToken: string }> {
  const password = opts.password ?? "password123";
  const role = opts.role ?? "reviewer";
  const name = opts.name ?? opts.email.split("@")[0];

  const [reviewer] = await db.insert(reviewers).values({
    id: generateId("user"),
    email: opts.email,
    name,
    password_hash: await bcrypt.hash(password, 10),
    role,
  }).returning();

  const loginRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: opts.email, password });

  return { reviewer, sessionToken: loginRes.body.token };
}
