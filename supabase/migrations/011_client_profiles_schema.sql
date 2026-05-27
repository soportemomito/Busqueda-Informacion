-- 011_client_profiles_schema.sql
-- Creación de tabla unificada por cliente

CREATE TABLE IF NOT EXISTS public.client_profiles (
  -- Identificadores base
  id bigint generated always as identity primary key,
  chatwoot_contact_id int unique, -- El ID del cliente en Chatwoot (nuestro ancla)
  
  -- Información Personal
  name text,
  email text,
  phone text,
  rut text,
  
  -- Información de Ubicación
  country text default 'CL',
  comuna text,
  address text,
  
  -- Arrays JSONB para agrupar múltiples datos sin usar tablas extra
  devices jsonb default '[]'::jsonb,
  service_orders jsonb default '[]'::jsonb,
  shopify_orders jsonb default '[]'::jsonb,
  
  -- Información Analítica
  latest_ai_summary text,             -- El último resumen generado
  customer_sentiment text,            
  satisfaction_level text,            
  
  -- Trazabilidad
  last_interaction_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índices para búsquedas ultra rápidas sin necesidad de joins
CREATE INDEX IF NOT EXISTS client_profiles_email_idx ON public.client_profiles(email);
CREATE INDEX IF NOT EXISTS client_profiles_phone_idx ON public.client_profiles(phone);
CREATE INDEX IF NOT EXISTS client_profiles_rut_idx ON public.client_profiles(rut);
CREATE INDEX IF NOT EXISTS client_profiles_devices_idx ON public.client_profiles USING GIN (devices);
