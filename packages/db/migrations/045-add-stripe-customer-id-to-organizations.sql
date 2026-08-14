-- 045-add-stripe-customer-id-to-organizations.sql
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email TEXT;
