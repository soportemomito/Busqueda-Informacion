-- Ejecutar después de 003_shopify_config.sql
-- Almacena datos de dispositivo extraídos de mensajes Chatwoot para cruce futuro.

create table if not exists public.device_facts (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  int         not null,
  contact_id       int,
  chatwoot_account_id int      default 1,
  label            text        not null,
  value            text        not null,
  captured_at      timestamptz default now(),
  constraint device_facts_unique unique (conversation_id, label, value)
);

create index if not exists device_facts_lookup_idx on public.device_facts (label, value);
create index if not exists device_facts_conv_idx   on public.device_facts (conversation_id);

comment on table public.device_facts is
  'Datos de dispositivo (IMEI, ICCID/SIM, Modelo, etc.) extraídos de mensajes Chatwoot. '
  'Permite cruzar tickets del mismo equipo aunque el cliente use canales distintos.';
