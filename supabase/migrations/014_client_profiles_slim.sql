-- 014_client_profiles_slim.sql
-- La ficha ahora es solo-notas (sin web) y se reduce a:
--   Nombre, Correo, Teléfono, IMEI/ID, SIM, Boletas, Pedidos,
--   Ingresos ST, Salidas ST, Tickets (#XXXX OPEN/CLOSED, sin resumen)
-- Se eliminan columnas que ya no alimentan la ficha (RUT, comuna, dirección,
-- resumen IA, sentimiento, satisfacción).

ALTER TABLE public.client_profiles
  DROP COLUMN IF EXISTS rut,
  DROP COLUMN IF EXISTS country,
  DROP COLUMN IF EXISTS comuna,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS latest_ai_summary,
  DROP COLUMN IF EXISTS customer_sentiment,
  DROP COLUMN IF EXISTS satisfaction_level;

-- Índice de RUT ya no aplica (la columna se eliminó)
DROP INDEX IF EXISTS public.client_profiles_rut_idx;
