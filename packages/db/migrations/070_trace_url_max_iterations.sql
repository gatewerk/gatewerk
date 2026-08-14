-- Migration 070: trace_url + max_iterations guardrail
-- Adds trace_url (agent-trace deep link) and max_iterations (revision-loop
-- cap) to reviews; adds max_iterations to templates as a template-level
-- default; extends the reviews decision CHECK to include
-- 'max_iterations_reached' (system-generated terminal decision).
-- -----------------------------------------------------------------------------

-- reviews.trace_url — optional https-only deep link to the originating
-- agent trace. Defense-in-depth CHECK mirrors the Zod .refine on the
-- shared schema; the route layer also enforces https-only before insert.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS trace_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'reviews'
      AND constraint_name = 'reviews_trace_url_https_chk'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_trace_url_https_chk
      CHECK (trace_url IS NULL OR trace_url LIKE 'https://%');
  END IF;
END;
$$;

-- reviews.max_iterations — optional per-review cap. When set and
-- current_version - 1 >= max_iterations on an awaiting_iteration tick,
-- TimeoutWorker closes the review as decided/max_iterations_reached.
-- CHECK >= 1 guards against a direct DB write of 0/negative which would make
-- `current_version > max_iterations` always true → instant close. Mirrors the
-- Zod .positive() guard at the API boundary (defense-in-depth).
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS max_iterations INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'reviews'
      AND constraint_name = 'reviews_max_iterations_positive_chk'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_max_iterations_positive_chk
      CHECK (max_iterations IS NULL OR max_iterations >= 1);
  END IF;
END;
$$;

-- templates.max_iterations — template-level default, inherited by new
-- reviews when the per-review field is not set.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS max_iterations INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'templates'
      AND constraint_name = 'templates_max_iterations_positive_chk'
  ) THEN
    ALTER TABLE templates
      ADD CONSTRAINT templates_max_iterations_positive_chk
      CHECK (max_iterations IS NULL OR max_iterations >= 1);
  END IF;
END;
$$;

-- Extend the reviews decision CHECK to include 'max_iterations_reached'.
-- Postgres requires DROP + ADD to change an existing CHECK constraint.
-- Constraint name: reviews_decision_chk (established in migration 028).
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_decision_chk;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_decision_chk
  CHECK (
    decision IS NULL
    OR decision IN ('approved', 'rejected', 'edited', 'retried', 'expired', 'max_iterations_reached')
  );

-- -----------------------------------------------------------------------------
-- DOWN (manual rollback)
-- -----------------------------------------------------------------------------
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_decision_chk;
-- ALTER TABLE reviews ADD CONSTRAINT reviews_decision_chk
--   CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'edited', 'retried', 'expired'));
-- ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_max_iterations_positive_chk;
-- ALTER TABLE templates DROP COLUMN IF EXISTS max_iterations;
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_max_iterations_positive_chk;
-- ALTER TABLE reviews DROP COLUMN IF EXISTS max_iterations;
-- ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_trace_url_https_chk;
-- ALTER TABLE reviews DROP COLUMN IF EXISTS trace_url;
