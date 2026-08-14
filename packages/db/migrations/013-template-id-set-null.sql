-- Make template_id nullable so reviews survive template deletion
-- Reviews keep template_slug (text) for identification
ALTER TABLE reviews ALTER COLUMN template_id DROP NOT NULL;

-- Change FK from RESTRICT to SET NULL
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_template_id_templates_id_fk;
ALTER TABLE reviews ADD CONSTRAINT reviews_template_id_templates_id_fk
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
