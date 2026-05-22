-- 006_chatwoot_panel_schema.sql
-- Schema completo para Chatwoot Panel (Dashboard App)
-- Ejecutar en Supabase SQL Editor. Usa IF NOT EXISTS en todo → es idempotente.

-- ============================================================
-- CONTACTS
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
-- CONVERSATIONS
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
-- DEVICES
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
-- CONTACT_DEVICES  (qué dispositivos ha usado cada contacto)
-- ============================================================
create table if not exists public.contact_devices (
  id           bigserial primary key,
  contact_id   bigint references public.contacts(id) on delete cascade,
  device_id    bigint references public.devices(id)  on delete cascade,
  relationship text,
  constraint contact_devices_unique unique (contact_id, device_id)
);

-- ============================================================
-- MESSAGES
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
-- EXTRACTED_ENTITIES
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
-- CONVERSATION_DEVICES  (qué dispositivos aparecieron en cada conv)
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
-- BSALE_DOCUMENTS
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
-- SHOPIFY_ORDERS
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
-- SERVICE_ORDERS
-- ============================================================
create table if not exists public.service_orders (
  id           bigserial primary key,
  order_number text        unique,
  device_id    bigint references public.devices(id)  on delete set null,
  contact_id   bigint references public.contacts(id) on delete set null,
  description  text,
  status       text,
  technician   text,
  received_at  timestamptz,
  raw_data     jsonb
);

create index if not exists service_orders_device_idx  on public.service_orders (device_id);
create index if not exists service_orders_contact_idx on public.service_orders (contact_id);

-- ============================================================
-- CONVERSATION_DOCUMENTS  (vincula convs con docs de cualquier tipo)
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
-- DUPLICATE_SIGNALS
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
-- CONVERSATION_MERGES
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
-- SYNC_LOG
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
-- FUNCTION: detect_duplicates(conversation_id integer)
-- Busca entidades comunes entre la conversación dada y otras,
-- e inserta señales en duplicate_signals.
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
  -- Obtener el id interno a partir del chatwoot_conversation_id
  select id into v_internal_id
  from public.conversations
  where chatwoot_conversation_id = p_conversation_id;

  if v_internal_id is null then
    return;
  end if;

  -- Recorrer cada entidad extraída de esta conversación
  for v_entity in
    select entity_type, normalized_value
    from   public.extracted_entities
    where  conversation_id = v_internal_id
      and  normalized_value is not null
  loop
    -- Buscar otras conversaciones con la misma entidad
    for v_other_cid in
      select distinct c.chatwoot_conversation_id
      from   public.extracted_entities ee
      join   public.conversations c on c.id = ee.conversation_id
      where  ee.entity_type       = v_entity.entity_type
        and  ee.normalized_value  = v_entity.normalized_value
        and  c.chatwoot_conversation_id != p_conversation_id
        and  c.is_merged = false
    loop
      -- Guardar siempre con (menor, mayor) para evitar duplicados invertidos
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
  'Detecta conversaciones duplicadas comparando entidades extraídas (IMEI, SIM, etc.).'
  ' Recibe chatwoot_conversation_id. Inserta en duplicate_signals con status=pending.';
