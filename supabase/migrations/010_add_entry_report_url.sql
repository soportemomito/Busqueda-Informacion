-- 010_add_entry_report_url.sql
-- Agrega la columna entry_report_url para almacenar el informe de entrada de servicio técnico desde Google Sheets.

ALTER TABLE public.service_orders
  ADD COLUMN IF NOT EXISTS entry_report_url text;
