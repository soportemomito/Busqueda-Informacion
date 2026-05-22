-- Add columns for Google Sheets sync (Hoja Salida)
ALTER TABLE service_orders
  ADD COLUMN IF NOT EXISTS contact_name  text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS report_url    text;

-- Index for email lookups during enrichment
CREATE INDEX IF NOT EXISTS idx_service_orders_contact_email
  ON service_orders (contact_email);
