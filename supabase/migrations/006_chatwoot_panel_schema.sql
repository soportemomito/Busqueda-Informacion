-- 006_chatwoot_panel_schema.sql
-- Schema completo y unificado para Chatwoot Panel (Dashboard App) y todo el sistema de ST
-- Ejecutar en Supabase SQL Editor. Usa IF NOT EXISTS en todo → es 100% idempotente y seguro de ejecutar múltiples veces.

-- ============================================================
-- 1. CONFIG
-- ============================================================
create table if not exists public.config (
  id                          smallint primary key default 1,
  chatwoot_base_url           text,
  chatwoot_api_token          text,
  bsale_api_token             text,
  shopify_api_token           text,
  chatwoot_account_id         text,
  shopify_admin_api_url       text,
  shopify_webhook_secret      text,
  gemini_api_key              text,
  drive_parent_folder_id      text, -- Obsoleto pero mantenido para compatibilidad de esquema
  drive_service_account_key   text, -- Obsoleto pero mantenido para compatibilidad de esquema
  updated_at                  timestamptz default now(),
  constraint config_singleton check (id = 1)
);

insert into public.config (id)
values (1)
on conflict (id) do nothing;

alter table public.config add column if not exists chatwoot_account_id text;
alter table public.config add column if not exists shopify_admin_api_url text;
alter table public.config add column if not exists shopify_webhook_secret text;
alter table public.config add column if not exists gemini_api_key text;
alter table public.config add column if not exists drive_parent_folder_id text;
alter table public.config add column if not exists drive_service_account_key text;

comment on table public.config is 'Credenciales internas SoyMomo ST System (editar vía /settings)';

-- ============================================================
-- 2. DEVICE_FACTS
-- ============================================================
create table if not exists public.device_facts (
  id                  uuid        primary key default gen_random_uuid(),
  conversation_id     int         not null,
  contact_id          int,
  chatwoot_account_id int         default 1,
  label               text        not null,
  value               text        not null,
  captured_at         timestamptz default now(),
  constraint device_facts_unique unique (conversation_id, label, value)
);

create index if not exists device_facts_lookup_idx on public.device_facts (label, value);
create index if not exists device_facts_conv_idx   on public.device_facts (conversation_id);

comment on table public.device_facts is
  'Datos de dispositivo (IMEI, ICCID/SIM, Modelo, etc.) extraídos de mensajes Chatwoot. Permite cruzar tickets del mismo equipo.';

-- ============================================================
-- 3. CHATWOOT_MESSAGES
-- ============================================================
create table if not exists public.chatwoot_messages (
  id              uuid primary key default gen_random_uuid(),
  message_id      int not null unique,
  conversation_id int not null,
  contact_id      int,
  content         text,
  message_type    text, -- 'incoming', 'outgoing', 'template', etc.
  sender_type     text, -- 'Contact', 'User', 'AgentBot'
  created_at      timestamptz default now(),
  raw_payload     jsonb -- Todo el evento del webhook
);

create index if not exists chatwoot_messages_conv_idx on public.chatwoot_messages (conversation_id);

comment on table public.chatwoot_messages is 'Historial completo de mensajes desde webhooks de Chatwoot';

-- ============================================================
-- 4. CONVERSATION_SUMMARIES
-- ============================================================
create table if not exists public.conversation_summaries (
  conversation_id          int primary key,
  contact_id               int,
  contact_name             text,
  contact_email            text,
  contact_phone            text,
  ai_summary               text,
  extracted_imei           text[],
  extracted_sim            text[],
  extracted_st_tickets     text[],
  extracted_shopify_orders text[],
  extracted_device_models  text[],
  last_message_at          timestamptz,
  updated_at               timestamptz default now()
);

-- Asegurar idempotencia si la tabla ya existía sin la columna de modelos extraídos
alter table public.conversation_summaries add column if not exists extracted_device_models text[];

create index if not exists conversation_summaries_contact_idx on public.conversation_summaries (contact_id);
create index if not exists conversation_summaries_imei_idx on public.conversation_summaries using gin(extracted_imei);
create index if not exists conversation_summaries_sim_idx on public.conversation_summaries using gin(extracted_sim);
create index if not exists conversation_summaries_st_idx on public.conversation_summaries using gin(extracted_st_tickets);
create index if not exists conversation_summaries_email_idx on public.conversation_summaries (contact_email);
create index if not exists conversation_summaries_phone_idx on public.conversation_summaries (contact_phone);

comment on table public.conversation_summaries is 'Ficha estructurada de cada conversación para consumo rápido desde la WebApp';

-- ============================================================
-- 5. CONTACTS
-- ============================================================
create table if not exists public.contacts (
  id                   bigserial primary key,
  chatwoot_contact_id  int        unique not null,
  name                 text,
  email                text,
  phone_whatsapp       text,
  synced_at            timestamptz default now()
);

create index if not exists contacts_email_idx on public.contacts (lower(email));
create index if not exists contacts_phone_idx on public.contacts (phone_whatsapp);
create index if not exists contacts_name_idx  on public.contacts using gin(to_tsvector('simple', coalesce(name, '')));

-- ============================================================
-- 6. CONVERSATIONS
-- ============================================================
create table if not exists public.conversations (
  id                           bigserial primary key,
  chatwoot_conversation_id     int        unique not null,
  chatwoot_inbox_id            int,
  channel_type                 text,
  contact_id                   bigint     references public.contacts(id) on delete set null,
  status                       text,
  assignee_name                text,
  labels                       text[],
  is_merged                    boolean    default false,
  merged_into_conversation_id  int,
  chatwoot_created_at          timestamptz,
  synced_at                    timestamptz default now()
);

create index if not exists conversations_contact_idx on public.conversations (contact_id);
create index if not exists conversations_status_idx  on public.conversations (status);

-- ============================================================
-- 7. DEVICES
-- ============================================================
create table if not exists public.devices (
  id      bigserial primary key,
  imei    text unique,
  sim_id  text,
  brand   text,
  model   text
);

create index if not exists devices_imei_idx  on public.devices (imei);
create index if not exists devices_sim_idx   on public.devices (sim_id);

-- ============================================================
-- 8. CONTACT_DEVICES  (Vínculo de contactos y dispositivos)
-- ============================================================
create table if not exists public.contact_devices (
  id           bigserial primary key,
  contact_id   bigint references public.contacts(id) on delete cascade,
  device_id    bigint references public.devices(id)  on delete cascade,
  relationship text,
  constraint contact_devices_unique unique (contact_id, device_id)
);

-- ============================================================
-- 9. MESSAGES
-- ============================================================
create table if not exists public.messages (
  id                       bigserial primary key,
  chatwoot_message_id      int        unique not null,
  conversation_id          bigint     references public.conversations(id) on delete cascade,
  content                  text,
  message_type             text,
  sender_type              text,
  processed_for_extraction boolean    default false
);

create index if not exists messages_conversation_idx  on public.messages (conversation_id);
create index if not exists messages_unprocessed_idx   on public.messages (processed_for_extraction) where processed_for_extraction = false;

-- ============================================================
-- 10. EXTRACTED_ENTITIES
-- ============================================================
create table if not exists public.extracted_entities (
  id                bigserial primary key,
  message_id        bigint references public.messages(id) on delete cascade,
  conversation_id   bigint references public.conversations(id) on delete cascade,
  entity_type       text    not null,  -- 'imei' | 'sim_id' | 'boleta' | 'shopify_order' | 'service_order'
  raw_value         text,
  normalized_value  text,
  validated         boolean default false
);

create index if not exists extracted_entities_conv_idx  on public.extracted_entities (conversation_id);
create index if not exists extracted_entities_type_val  on public.extracted_entities (entity_type, normalized_value);

-- ============================================================
-- 11. CONVERSATION_DEVICES
-- ============================================================
create table if not exists public.conversation_devices (
  id                 bigserial primary key,
  conversation_id    bigint references public.conversations(id) on delete cascade,
  device_id          bigint references public.devices(id)       on delete cascade,
  extraction_method  text,
  raw_text_fragment  text,
  constraint conversation_devices_unique unique (conversation_id, device_id)
);

-- ============================================================
-- 12. BSALE_DOCUMENTS
-- ============================================================
create table if not exists public.bsale_documents (
  id               bigserial primary key,
  document_number  text        unique,
  document_type    text,
  contact_name     text,
  contact_email    text,
  total_amount     numeric(12, 2),
  issued_at        timestamptz,
  raw_data         jsonb,
  fetched_at       timestamptz default now()
);

create index if not exists bsale_docs_email_idx on public.bsale_documents (lower(contact_email));

-- ============================================================
-- 13. SHOPIFY_ORDERS
-- ============================================================
create table if not exists public.shopify_orders (
  id                bigserial primary key,
  shopify_order_id  text        unique not null,
  order_name        text,
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  status            text,
  financial_status  text,
  total_price       numeric(12, 2),
  raw_data          jsonb,
  fetched_at        timestamptz default now()
);

create index if not exists shopify_email_idx on public.shopify_orders (lower(contact_email));
create index if not exists shopify_phone_idx on public.shopify_orders (contact_phone);
create index if not exists shopify_name_idx  on public.shopify_orders (order_name);

-- ============================================================
-- 14. SERVICE_ORDERS
-- ============================================================
create table if not exists public.service_orders (
  id                bigserial primary key,
  order_number      text        unique,
  device_id         bigint references public.devices(id)  on delete set null,
  contact_id        bigint references public.contacts(id) on delete set null,
  description       text,
  status            text,
  technician        text,
  received_at       timestamptz,
  contact_name      text,
  contact_email     text,
  report_url        text,
  entry_report_url  text,
  entry_date        timestamptz,
  exit_date         timestamptz,
  check_in_notes    text,
  check_out_notes   text,
  solution          text,
  imei_sim          text,
  sheet_row_url     text,
  raw_data          jsonb
);

create index if not exists service_orders_device_idx  on public.service_orders (device_id);
create index if not exists service_orders_contact_idx on public.service_orders (contact_id);

-- Asegurar idempotencia si la tabla ya existía sin los campos extendidos/nuevos
alter table public.service_orders add column if not exists contact_name     text;
alter table public.service_orders add column if not exists contact_email    text;
alter table public.service_orders add column if not exists report_url       text;
alter table public.service_orders add column if not exists entry_report_url text;
alter table public.service_orders add column if not exists entry_date       timestamptz;
alter table public.service_orders add column if not exists exit_date        timestamptz;
alter table public.service_orders add column if not exists check_in_notes   text;
alter table public.service_orders add column if not exists check_out_notes  text;
alter table public.service_orders add column if not exists solution         text;
alter table public.service_orders add column if not exists imei_sim         text;
alter table public.service_orders add column if not exists sheet_row_url    text;

-- Índices optimizados para búsquedas rápidas en ST
create index if not exists idx_service_orders_contact_email  on public.service_orders (contact_email);
create index if not exists idx_service_orders_imei_sim       on public.service_orders (imei_sim);
create index if not exists idx_service_orders_order_number   on public.service_orders (order_number);

-- ============================================================
-- 15. CONVERSATION_DOCUMENTS
-- ============================================================
create table if not exists public.conversation_documents (
  id               bigserial primary key,
  conversation_id  bigint references public.conversations(id) on delete cascade,
  document_type    text   not null,  -- 'bsale' | 'shopify' | 'service_order'
  document_id      bigint not null,  -- PK de la tabla correspondiente
  linked_method    text,             -- 'extraction' | 'email' | 'phone' | 'imei'
  constraint conversation_documents_unique unique (conversation_id, document_type, document_id)
);

create index if not exists conv_docs_conv_idx on public.conversation_documents (conversation_id);

-- ============================================================
-- 16. DUPLICATE_SIGNALS
-- ============================================================
create table if not exists public.duplicate_signals (
  id                  bigserial primary key,
  signal_type         text    not null,              -- 'imei' | 'sim_id' | 'email' | 'phone'
  signal_value        text,
  conversation_id_a   int     not null,              -- chatwoot_conversation_id (menor)
  conversation_id_b   int     not null,              -- chatwoot_conversation_id (mayor)
  status              text    default 'pending',     -- 'pending' | 'merged' | 'dismissed'
  detected_at         timestamptz default now(),
  constraint duplicate_signals_unique unique (signal_type, signal_value, conversation_id_a, conversation_id_b)
);

create index if not exists dup_signals_status_idx on public.duplicate_signals (status);
create index if not exists dup_signals_conv_a_idx on public.duplicate_signals (conversation_id_a);
create index if not exists dup_signals_conv_b_idx on public.duplicate_signals (conversation_id_b);

-- ============================================================
-- 17. CONVERSATION_MERGES
-- ============================================================
create table if not exists public.conversation_merges (
  id                       bigserial primary key,
  base_conversation_id     int    not null,
  merged_conversation_id   int    not null,
  triggered_by             text,
  merged_at                timestamptz default now(),
  chatwoot_merge_confirmed boolean     default false
);

-- ============================================================
-- 18. SYNC_LOG
-- ============================================================
create table if not exists public.sync_log (
  id             bigserial primary key,
  event_type     text,
  source         text,
  reference_id   text,
  status         text,         -- 'success' | 'error'
  error_message  text,
  created_at     timestamptz default now()
);

create index if not exists sync_log_created_idx on public.sync_log (created_at desc);
create index if not exists sync_log_status_idx  on public.sync_log (status);

-- ============================================================
-- 19. FUNCTION: detect_duplicates(conversation_id integer)
-- ============================================================
create or replace function public.detect_duplicates(p_conversation_id integer)
returns void
language plpgsql
as $$
declare
  v_internal_id   bigint;
  v_entity        record;
  v_other_cid     int;
begin
  select id into v_internal_id
  from public.conversations
  where chatwoot_conversation_id = p_conversation_id;

  if v_internal_id is null then
    return;
  end if;

  for v_entity in
    select entity_type, normalized_value
    from   public.extracted_entities
    where  conversation_id = v_internal_id
      and  normalized_value is not null
  loop
    for v_other_cid in
      select distinct c.chatwoot_conversation_id
      from   public.extracted_entities ee
      join   public.conversations c on c.id = ee.conversation_id
      where  ee.entity_type       = v_entity.entity_type
        and  ee.normalized_value  = v_entity.normalized_value
        and  c.chatwoot_conversation_id != p_conversation_id
        and  c.is_merged = false
    loop
      insert into public.duplicate_signals
        (signal_type, signal_value, conversation_id_a, conversation_id_b, status)
      values (
        v_entity.entity_type,
        v_entity.normalized_value,
        least(p_conversation_id,    v_other_cid),
        greatest(p_conversation_id, v_other_cid),
        'pending'
      )
      on conflict (signal_type, signal_value, conversation_id_a, conversation_id_b)
      do nothing;
    end loop;
  end loop;
end;
$$;

comment on function public.detect_duplicates(integer) is
  'Detecta conversaciones duplicadas comparando entidades extraídas (IMEI, SIM, etc.). Recibe chatwoot_conversation_id.';
