-- 008_gemini_config.sql
-- Añade soporte para configurar la clave de API de Gemini directamente

alter table public.config
  add column if not exists gemini_api_key text;

comment on column public.config.gemini_api_key is 'Clave de API de Google Gemini para resúmenes de conversación y extracción inteligente de datos';
