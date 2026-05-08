-- Ejecutar en Supabase SQL Editor (o como migración).
-- El backend usa SERVICE_ROLE y puede leer/escribir sin políticas públicas.

create table if not exists public.config (
  id smallint primary key default 1,
  chatwoot_base_url text,
  chatwoot_api_token text,
  bsale_api_token text,
  shopify_api_token text,
  updated_at timestamptz default now(),
  constraint config_singleton check (id = 1)
);

insert into public.config (id)
values (1)
on conflict (id) do nothing;

comment on table public.config is 'Credenciales internas SoyMomo ST System (editar vía /settings)';
