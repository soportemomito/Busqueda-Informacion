-- Ejecutar después de 002_config_extended.sql
-- URLs y secretos Shopify (el token Admin ya existe como shopify_api_token en 001_config.sql)

alter table public.config
  add column if not exists shopify_admin_api_url text;

alter table public.config
  add column if not exists shopify_webhook_secret text;
