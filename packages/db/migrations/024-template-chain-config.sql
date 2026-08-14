-- 024-template-chain-config.sql
--
-- M12 — chain_config JSONB on templates.
-- Resolves chain-and-escalation spec §13 Q1 with option (a): chain definitions
-- live as a JSONB column on the existing templates table (vs. a standalone
-- chain_templates table; that's option (b), deferred per spec).
--
-- When a template has a non-null chain_config, POST /reviews against that
-- template auto-spawns a chain_run via ChainEngine.createRun and the created
-- review becomes step 1 of the chain.
--
-- Shape is enforced at write time by zod (ChainDefinitionSchema in
-- packages/shared/src/api/schemas/chains.ts), not by a DB CHECK — keeps the
-- migration cheap on existing rows and avoids duplicating refinement logic.
-- Existing rows are NULL (no chain), which is the correct default.

ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS chain_config JSONB;

-- DOWN (commented — Drizzle doesn't auto-roll-back; manual recovery only):
--   ALTER TABLE templates DROP COLUMN IF EXISTS chain_config;
