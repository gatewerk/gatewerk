-- Block 6 C1 (2026-05-18): Drop hmac_secret column from webhook_deliveries.
-- The per-row secret snapshot was a verbatim copy of projects.hmac_secret,
-- increasing DB blast-radius with no meaningful gain. At retry time the worker
-- now JOINs webhook_deliveries → reviews → projects to fetch the CURRENT secret.
-- Rotation between attempts is by-design — receivers dedupe via delivery_id.
ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS hmac_secret;
