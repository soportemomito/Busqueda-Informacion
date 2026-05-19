-- 005_chatwoot_intelligence.sql
-- Almacena el historial crudo de mensajes y resúmenes estructurados

-- 1. Tabla para historial de mensajes brutos
create table if not exists public.chatwoot_messages (
  id uuid primary key default gen_random_uuid(),
  message_id int not null unique,
  conversation_id int not null,
  contact_id int,
  content text,
  message_type text, -- 'incoming', 'outgoing', 'template', etc.
  sender_type text, -- 'Contact', 'User', 'AgentBot'
  created_at timestamptz default now(),
  raw_payload jsonb -- Todo el evento del webhook
);

create index if not exists chatwoot_messages_conv_idx on public.chatwoot_messages (conversation_id);

-- 2. Tabla para resúmenes e información extraída consolidada por conversación
create table if not exists public.conversation_summaries (
  conversation_id int primary key,
  contact_id int,
  contact_name text,
  contact_email text,
  contact_phone text,
  ai_summary text,
  extracted_imei text[],
  extracted_sim text[],
  extracted_st_tickets text[],
  extracted_shopify_orders text[],
  last_message_at timestamptz,
  updated_at timestamptz default now()
);

create index if not exists conversation_summaries_contact_idx on public.conversation_summaries (contact_id);
-- Indices GIN para búsqueda rápida en arrays (útiles para cruzar tickets por IMEI, SIM, etc.)
create index if not exists conversation_summaries_imei_idx on public.conversation_summaries using gin(extracted_imei);
create index if not exists conversation_summaries_sim_idx on public.conversation_summaries using gin(extracted_sim);
create index if not exists conversation_summaries_st_idx on public.conversation_summaries using gin(extracted_st_tickets);
create index if not exists conversation_summaries_email_idx on public.conversation_summaries (contact_email);
create index if not exists conversation_summaries_phone_idx on public.conversation_summaries (contact_phone);

comment on table public.chatwoot_messages is 'Historial completo de mensajes desde webhooks de Chatwoot';
comment on table public.conversation_summaries is 'Ficha estructurada de cada conversación para consumo rápido desde la WebApp';
