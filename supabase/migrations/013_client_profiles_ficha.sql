-- 013_client_profiles_ficha.sql
-- Campos para persistir la ficha consolidada completa del cliente
-- (boletas Bsale, historial de tickets y el markdown final de la ficha)

ALTER TABLE public.client_profiles
  ADD COLUMN IF NOT EXISTS bsale_folios jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tickets jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ficha_markdown text,
  ADD COLUMN IF NOT EXISTS ficha_synced_at timestamptz;

COMMENT ON COLUMN public.client_profiles.bsale_folios IS 'Array de boletas Bsale: [{number, url, total, date}]';
COMMENT ON COLUMN public.client_profiles.tickets IS 'Array de tickets Chatwoot: [{ticket_id, summary, status}]';
COMMENT ON COLUMN public.client_profiles.ficha_markdown IS 'Última ficha consolidada renderizada (markdown)';
COMMENT ON COLUMN public.client_profiles.ficha_synced_at IS 'Última vez que la ficha se sincronizó como nota de contacto en Chatwoot';
