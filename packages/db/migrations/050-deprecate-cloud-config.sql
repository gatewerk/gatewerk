-- 050-deprecate-cloud-config.sql
UPDATE organizations SET cloud_config = NULL WHERE cloud_config IS NOT NULL;
