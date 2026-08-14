-- Storage-layer uniqueness for (project_id, slug) on templates.
-- Application-layer slug validation via TemplateCreateBodySchema gates the
-- format, but the DB has had no guard against two concurrent creates with
-- identical (project_id, slug) — both inserts would succeed, leaving
-- getBySlug() with non-deterministic resolution and breaking review creation
-- by slug.
--
-- Duplicates created before this migration are de-duplicated by appending
-- the row id's suffix to the slug — picks a deterministic winner without
-- discarding data.
CREATE OR REPLACE FUNCTION pg_temp.dedupe_template_slugs() RETURNS void AS $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN (
    SELECT id, slug
    FROM (
      SELECT id, slug, project_id,
        row_number() OVER (PARTITION BY project_id, slug ORDER BY created_at ASC, id ASC) AS rn
      FROM templates
    ) s
    WHERE rn > 1
  ) LOOP
    UPDATE templates
    SET slug = dup.slug || '-' || right(dup.id, 8)
    WHERE id = dup.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT pg_temp.dedupe_template_slugs();

CREATE UNIQUE INDEX IF NOT EXISTS templates_project_id_slug_uniq
  ON templates (project_id, slug);
