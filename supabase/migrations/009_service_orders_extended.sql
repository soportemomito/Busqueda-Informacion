-- 009_service_orders_extended.sql
-- Amplía la tabla service_orders para almacenar datos detallados de entradas (check-in) y salidas (check-out) desde Google Sheets.

ALTER TABLE public.service_orders
  ADD COLUMN IF NOT EXISTS entry_date timestamptz,
  ADD COLUMN IF NOT EXISTS exit_date timestamptz,
  ADD COLUMN IF NOT EXISTS check_in_notes text,
  ADD COLUMN IF NOT EXISTS check_out_notes text,
  ADD COLUMN IF NOT EXISTS solution text,
  ADD COLUMN IF NOT EXISTS imei_sim text,
  ADD COLUMN IF NOT EXISTS sheet_row_url text;

-- Índices optimizados para búsquedas rápidas por IMEI o número de orden
CREATE INDEX IF NOT EXISTS idx_service_orders_imei_sim ON public.service_orders (imei_sim);
CREATE INDEX IF NOT EXISTS idx_service_orders_order_number ON public.service_orders (order_number);
