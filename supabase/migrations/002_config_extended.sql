-- Ejecutar después de 001_config.sql
alter table public.config
  add column if not exists chatwoot_account_id text;

alter table public.config
  add column if not exists drive_parent_folder_id text;

alter table public.config
  add column if not exists drive_service_account_key text;
