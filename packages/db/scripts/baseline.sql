-- baseline-through: 073_template_fields_snapshot
CREATE TABLE "account_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signup_cohort" date NOT NULL,
	"churn_cohort" date NOT NULL,
	"plan_at_churn" text NOT NULL,
	"mrr_cents" integer DEFAULT 0 NOT NULL,
	"ltv_cents" integer DEFAULT 0 NOT NULL,
	"trial_converted" boolean NOT NULL,
	"trial_days" smallint,
	"account_age_days" integer NOT NULL,
	"reviews_created" integer DEFAULT 0 NOT NULL,
	"api_calls_total" integer DEFAULT 0 NOT NULL,
	"templates_created" integer DEFAULT 0 NOT NULL,
	"tokens_generated" integer DEFAULT 0 NOT NULL,
	"completed_onboarding" boolean DEFAULT false NOT NULL,
	"reached_first_review" boolean DEFAULT false NOT NULL,
	"reached_first_approval" boolean DEFAULT false NOT NULL,
	"upgraded_from_trial" boolean DEFAULT false NOT NULL,
	"deletion_reason" text NOT NULL
);

CREATE TABLE "api_key_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"api_key_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"label" text,
	"scopes" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"description" text,
	"callback_url" text,
	"default_reviewer" text,
	"rate_limit_per_hour" integer,
	"template_ids" jsonb,
	"expires_at" timestamp with time zone,
	"ip_allowlist" jsonb
);

CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" jsonb,
	"signature" text,
	"prev_signature" text,
	"signature_version" smallint DEFAULT 1 NOT NULL,
	"project_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "chain_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text,
	"name" text,
	"mode" text DEFAULT 'sequential' NOT NULL,
	"rejection_policy" text DEFAULT 'terminate' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);

CREATE TABLE "chain_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_run_id" text NOT NULL,
	"step_number" integer NOT NULL,
	"review_id" text,
	"assignee_spec" jsonb NOT NULL,
	"depends_on" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"materialized_at" timestamp with time zone,
	"rejection_policy" text,
	"rejection_branch_to" integer
);

CREATE TABLE "cloud_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"last_event_at" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_dunning_sent_at" timestamp with time zone,
	CONSTRAINT "cloud_subscriptions_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "cloud_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);

CREATE TABLE "email_otp_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "invite_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'reviewer' NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "jobs_daily_digest_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);

CREATE TABLE "note_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"attached_by" text,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_attachments_unique" UNIQUE("note_id","target_kind","target_id"),
	CONSTRAINT "note_attachments_target_kind_chk" CHECK ("note_attachments"."target_kind" IN ('review', 'template', 'chain_run'))
);

CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"author_id" text,
	"author_display_fallback" text,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_author_present" CHECK ("notes"."author_id" IS NOT NULL OR "notes"."author_display_fallback" IS NOT NULL)
);

CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"webhook_url" text NOT NULL,
	"events" jsonb NOT NULL,
	"headers" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"type" text DEFAULT 'generic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_membership_unique" UNIQUE("organization_id","user_id")
);

CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"cloud_config" jsonb,
	"stripe_customer_id" text,
	"billing_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"webhook_url" text,
	"hmac_secret" text NOT NULL,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_id" text DEFAULT 'community' NOT NULL,
	"entitlements_override" jsonb,
	"trial_ends_at" timestamp with time zone,
	"seat_count" integer DEFAULT 1 NOT NULL
);

CREATE TABLE "review_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"author" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "review_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"review_id" text NOT NULL,
	"project_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"decision" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"recipient_label" text NOT NULL,
	"note" text,
	"auth_level" text DEFAULT 'public' NOT NULL,
	"auth_email" text,
	"auth_user_id" text,
	"created_by_kind" text NOT NULL,
	"created_by_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"decided_by_email" text,
	"decided_by_user_id" text,
	"is_preview" boolean DEFAULT false NOT NULL,
	"verification_attempts" integer DEFAULT 0 NOT NULL,
	"otp_locked_until" timestamp with time zone
);

CREATE TABLE "review_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "reviewers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'reviewer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"totp_secret_encrypted" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_backup_codes" text,
	"last_used_totp_at" timestamp with time zone,
	"email_verified_at" timestamp with time zone,
	"password_reset_token_hash" text,
	"password_reset_expires_at" timestamp with time zone,
	"login_notifications" boolean DEFAULT true NOT NULL,
	"supabase_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewers_email_unique" UNIQUE("email"),
	CONSTRAINT "reviewers_supabase_user_id_unique" UNIQUE("supabase_user_id"),
	CONSTRAINT "reviewers_role_chk" CHECK ("reviewers"."role" IN ('admin', 'reviewer'))
);

CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"template_id" text,
	"template_slug" text NOT NULL,
	"payload" jsonb NOT NULL,
	"suggested_value" jsonb,
	"approved_value" jsonb,
	"callback_url" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"actions" jsonb DEFAULT '["approve","reject"]'::jsonb NOT NULL,
	"confidence" real,
	"irreversibility" text,
	"oversight" text DEFAULT 'blocking' NOT NULL,
	"assignee" text,
	"metadata" jsonb,
	"timeout_action" text,
	"timeout_seconds" integer,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" text,
	"edited_payload" jsonb,
	"feedback" text,
	"prompt_edit" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"last_action_id" text,
	"last_action_kind" text,
	"last_action_at" timestamp with time zone,
	"last_action_by" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"draft_payload" jsonb,
	"draft_by" text,
	"draft_at" timestamp with time zone,
	"held_by" text,
	"held_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"action_value" text,
	"action_label" text,
	"assignment_ladder" jsonb,
	"ladder_index" integer DEFAULT 0 NOT NULL,
	"ladder_next_promote_at" timestamp with time zone,
	"chain_run_id" text,
	"chain_step_id" text,
	"prev_step_ids" jsonb,
	"idempotency_key" text,
	"trace_url" text,
	"max_iterations" integer,
	"template_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_priority_chk" CHECK ("reviews"."priority" IN ('low', 'normal', 'high', 'critical')),
	CONSTRAINT "reviews_status_chk" CHECK ("reviews"."status" IN ('pending', 'awaiting_iteration', 'awaiting_external', 'decided', 'expired', 'archived', 'monitoring')),
	CONSTRAINT "reviews_trace_url_https_chk" CHECK ("reviews"."trace_url" IS NULL OR "reviews"."trace_url" LIKE 'https://%'),
	CONSTRAINT "reviews_max_iterations_positive_chk" CHECK ("reviews"."max_iterations" IS NULL OR "reviews"."max_iterations" >= 1),
	CONSTRAINT "reviews_decision_chk" CHECK ("reviews"."decision" IS NULL OR "reviews"."decision" IN ('approved', 'rejected', 'edited', 'retried', 'expired', 'max_iterations_reached', 'confirmed', 'vetoed')),
	CONSTRAINT "reviews_oversight_chk" CHECK ("reviews"."oversight" IN ('blocking', 'monitoring')),
	CONSTRAINT "reviews_last_action_kind_chk" CHECK ("reviews"."last_action_kind" IS NULL OR "reviews"."last_action_kind" IN ('decision', 'iteration', 'side_effect'))
);

CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"reviewer_id" text NOT NULL,
	"jti" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_jti_unique" UNIQUE("jti")
);

CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);

CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"fields" jsonb NOT NULL,
	"actions" jsonb DEFAULT '["approve","reject"]'::jsonb NOT NULL,
	"default_priority" text DEFAULT 'normal' NOT NULL,
	"enable_review_links" boolean DEFAULT false NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"timeout_seconds" integer,
	"timeout_action" text,
	"changes_timeout_hours" integer,
	"instructions" text,
	"allow_request_changes" boolean DEFAULT true NOT NULL,
	"allow_notes" boolean DEFAULT true NOT NULL,
	"allow_monitoring" boolean DEFAULT false NOT NULL,
	"default_auth_level" text DEFAULT 'public' NOT NULL,
	"default_expiry_seconds" integer DEFAULT 86400 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"draft_config" jsonb,
	"draft_updated_at" timestamp with time zone,
	"chain_config" jsonb,
	"max_iterations" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_status_chk" CHECK ("templates"."status" IN ('draft', 'active', 'inactive')),
	CONSTRAINT "templates_max_iterations_positive_chk" CHECK ("templates"."max_iterations" IS NULL OR "templates"."max_iterations" >= 1)
);

CREATE TABLE "usage_daily_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"rollup_date" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_rollups_org_type_date_uniq" UNIQUE("organization_id","event_type","rollup_date")
);

CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);

CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[],
	"aaguid" text,
	"friendly_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);

CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"event_type" text NOT NULL,
	"url" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "meter_event_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"event_name" text NOT NULL,
	"value" numeric NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "meter_event_queue_idempotency_key_unique" UNIQUE("idempotency_key")
);

ALTER TABLE "api_key_usage" ADD CONSTRAINT "api_key_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chain_runs" ADD CONSTRAINT "chain_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chain_runs" ADD CONSTRAINT "chain_runs_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "chain_steps" ADD CONSTRAINT "chain_steps_chain_run_id_chain_runs_id_fk" FOREIGN KEY ("chain_run_id") REFERENCES "public"."chain_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "chain_steps" ADD CONSTRAINT "chain_steps_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "cloud_subscriptions" ADD CONSTRAINT "cloud_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "email_otp_codes" ADD CONSTRAINT "email_otp_codes_token_id_review_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."review_tokens"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_invited_by_reviewers_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."reviewers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "note_attachments" ADD CONSTRAINT "note_attachments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "note_attachments" ADD CONSTRAINT "note_attachments_attached_by_reviewers_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."reviewers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_reviewers_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."reviewers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_reviewers_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "review_tokens" ADD CONSTRAINT "review_tokens_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "review_tokens" ADD CONSTRAINT "review_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "review_versions" ADD CONSTRAINT "review_versions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "templates" ADD CONSTRAINT "templates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "usage_daily_rollups" ADD CONSTRAINT "usage_daily_rollups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_reviewers_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."reviewers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "api_key_usage_lookup" ON "api_key_usage" USING btree ("api_key_id","created_at" DESC NULLS LAST);
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");
CREATE INDEX "audit_log_project_id_idx" ON "audit_log" USING btree ("project_id");
CREATE INDEX "chain_runs_project_id_idx" ON "chain_runs" USING btree ("project_id","created_at" DESC NULLS LAST);
CREATE INDEX "chain_runs_active_idx" ON "chain_runs" USING btree ("project_id","created_at" DESC NULLS LAST);
CREATE UNIQUE INDEX "chain_steps_chain_run_id_step_number_unique" ON "chain_steps" USING btree ("chain_run_id","step_number");
CREATE INDEX "chain_steps_chain_run_id_idx" ON "chain_steps" USING btree ("chain_run_id","step_number");
CREATE INDEX "cloud_subscriptions_status_trial_idx" ON "cloud_subscriptions" USING btree ("status","trial_ends_at") WHERE "cloud_subscriptions"."trial_ends_at" IS NOT NULL;
CREATE INDEX "email_otp_codes_token_id_idx" ON "email_otp_codes" USING btree ("token_id");
CREATE UNIQUE INDEX "invite_tokens_token_hash_idx" ON "invite_tokens" USING btree ("token_hash");
CREATE INDEX "invite_tokens_email_idx" ON "invite_tokens" USING btree ("email");
CREATE INDEX "note_attachments_target_idx" ON "note_attachments" USING btree ("target_kind","target_id");
CREATE INDEX "note_attachments_note_idx" ON "note_attachments" USING btree ("note_id");
CREATE INDEX "notes_project_shared_idx" ON "notes" USING btree ("project_id","is_shared","created_at" DESC NULLS LAST) WHERE "notes"."deleted_at" IS NULL;
CREATE INDEX "notes_author_idx" ON "notes" USING btree ("project_id","author_id","created_at" DESC NULLS LAST) WHERE "notes"."deleted_at" IS NULL;
CREATE INDEX "notes_tags_idx" ON "notes" USING gin ("tags") WHERE "notes"."deleted_at" IS NULL;
CREATE INDEX "org_memberships_org_idx" ON "organization_memberships" USING btree ("organization_id");
CREATE INDEX "org_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");
CREATE INDEX "idx_projects_plan_id" ON "projects" USING btree ("plan_id");
CREATE INDEX "review_notes_review_id_idx" ON "review_notes" USING btree ("review_id");
CREATE UNIQUE INDEX "review_tokens_token_hash_idx" ON "review_tokens" USING btree ("token_hash");
CREATE INDEX "review_tokens_review_id_idx" ON "review_tokens" USING btree ("review_id");
CREATE INDEX "review_tokens_review_id_created_at_idx" ON "review_tokens" USING btree ("review_id","created_at" DESC NULLS LAST);
CREATE INDEX "review_tokens_project_id_expires_at_idx" ON "review_tokens" USING btree ("project_id","expires_at");
CREATE INDEX "reviews_project_id_status_created_at_idx" ON "reviews" USING btree ("project_id","status","created_at" DESC NULLS LAST);
CREATE INDEX "reviews_project_id_template_slug_created_at_idx" ON "reviews" USING btree ("project_id","template_slug","created_at" DESC NULLS LAST);
CREATE INDEX "reviews_project_id_assignee_created_at_idx" ON "reviews" USING btree ("project_id","assignee","created_at" DESC NULLS LAST);
CREATE INDEX "reviews_expires_at_idx" ON "reviews" USING btree ("expires_at");
CREATE INDEX "reviews_ladder_next_promote_at_idx" ON "reviews" USING btree ("ladder_next_promote_at");
CREATE INDEX "reviews_chain_run_id_idx" ON "reviews" USING btree ("chain_run_id");
CREATE INDEX "reviews_project_id_idempotency_key_idx" ON "reviews" USING btree ("project_id","idempotency_key");
CREATE INDEX "reviews_held_by_idx" ON "reviews" USING btree ("held_by");
CREATE INDEX "reviews_snoozed_until_idx" ON "reviews" USING btree ("snoozed_until");
CREATE INDEX "templates_project_id_status_created_at_idx" ON "templates" USING btree ("project_id","status","created_at" DESC NULLS LAST);
CREATE UNIQUE INDEX "templates_project_id_slug_uniq" ON "templates" USING btree ("project_id","slug");
CREATE INDEX "usage_daily_rollups_org_date_idx" ON "usage_daily_rollups" USING btree ("organization_id","rollup_date");
CREATE INDEX "usage_events_org_type_date_idx" ON "usage_events" USING btree ("organization_id","event_type","counted_at");
CREATE INDEX "idx_webauthn_credentials_user_credential" ON "webauthn_credentials" USING btree ("user_id","credential_id");
CREATE INDEX "idx_meter_event_queue_pending" ON "meter_event_queue" USING btree ("status") WHERE "meter_event_queue"."status" = 'pending';
CREATE INDEX "idx_meter_event_queue_customer" ON "meter_event_queue" USING btree ("stripe_customer_id","created_at");
