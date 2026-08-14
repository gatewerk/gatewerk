-- Last-delivery visibility for notification_channels (Settings > Project >
-- Webhooks). NotificationService (services/notifications.ts) dispatches these
-- fire-and-forget on real events with no persistence — a failing webhook was
-- previously invisible outside server logs. These three columns are updated
-- from that same fire-and-forget path after every attempt, success or
-- failure; last_error is cleared on a subsequent success so the row never
-- shows a stale failure after the endpoint has recovered.

ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_delivery_at TIMESTAMPTZ;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_delivery_status TEXT;
ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_error TEXT;

-- DOWN
-- ALTER TABLE notification_channels DROP COLUMN IF EXISTS last_delivery_at;
-- ALTER TABLE notification_channels DROP COLUMN IF EXISTS last_delivery_status;
-- ALTER TABLE notification_channels DROP COLUMN IF EXISTS last_error;
