-- Migration 011: Organizations foundation for multi-tenancy
-- Pattern: Langfuse (cloud_config JSON), Cal.com (env-var mode), Sentry (same codebase)

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  cloud_config jsonb,  -- null in OSS, populated in cloud (billing, plan, limits)
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Organization memberships
CREATE TABLE IF NOT EXISTS organization_memberships (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS org_memberships_org_idx ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS org_memberships_user_idx ON organization_memberships(user_id);

-- Add organization_id to projects (nullable for backwards compat — existing projects have no org yet)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id);
